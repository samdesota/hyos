import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { micromark } from "micromark";

import type {
  AgentMessage,
  AgentMode,
  AgentReasoningEffort,
  AgentMessageChange,
  AgentProviderSummary,
  AgentSessionSummary,
} from "../../capabilities/agent.js";
import type { AgentClient, AgentMessageFeed } from "./client.js";
import { createAutoScrollController } from "./auto-scroll.js";
import { DiffViewer } from "./DiffViewer.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import { agentStyles } from "./styles.js";
import { selectedMode } from "./mode-selection.js";
import { syncHashToSession, sessionFromHash } from "./session-route.js";

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
}>;

type TimelineEntry =
  | Readonly<{ type: "message"; message: AgentMessage }>
  | Readonly<{ type: "tools"; messages: readonly AgentMessage[] }>
  | Readonly<{
      type: "work";
      entries: readonly TimelineEntry[];
      startedAt: Date;
      endedAt: Date;
    }>;

const isWorkItem = (entry: TimelineEntry): boolean =>
  entry.type === "tools" ||
  (entry.type === "message" && entry.message.activity?.type === "commentary");

const firstCreatedAt = (entry: TimelineEntry): Date =>
  entry.type === "tools"
    ? entry.messages[0].createdAt
    : entry.type === "message"
      ? entry.message.createdAt
      : entry.startedAt;

export function workPaneLabel(
  startedAt: Date,
  endedAt: Date,
  now: Date = new Date(),
): string {
  const seconds = Math.max(
    1,
    Math.round(((endedAt ?? now).getTime() - startedAt.getTime()) / 1000),
  );
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `Worked for ${minutes}m ${rest}s` : `Worked for ${minutes}m`;
}

/** Collapse each finished run's tool/commentary activity into a summary pane. */
export function collapseWorkRuns(
  entries: readonly TimelineEntry[],
): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  let pending: TimelineEntry[] = [];
  const flush = (final?: AgentMessage) => {
    if (!pending.length) return;
    const canCollapse =
      final !== undefined && final.status !== "streaming" && !final.lastError;
    if (canCollapse) {
      result.push({
        type: "work",
        entries: pending,
        startedAt: firstCreatedAt(pending[0]),
        endedAt: final.createdAt,
      });
    } else {
      result.push(...pending);
    }
    pending = [];
  };
  for (const entry of entries) {
    if (isWorkItem(entry)) {
      pending.push(entry);
      continue;
    }
    flush(entry.type === "message" ? entry.message : undefined);
    result.push(entry);
  }
  flush();
  return result;
}

export function timelineEntries(
  messages: readonly AgentMessage[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const ordered = [...messages].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  for (const message of ordered) {
    if (message.activity?.type === "patch") continue;
    if (
      !message.content &&
      message.role === "assistant" &&
      !message.lastError &&
      message.status !== "streaming"
    )
      continue;
    if (message.activity?.type === "tool") {
      const last = entries.at(-1);
      if (last?.type === "tools") {
        entries[entries.length - 1] = {
          type: "tools",
          messages: [...last.messages, message],
        };
      } else {
        entries.push({ type: "tools", messages: [message] });
      }
    } else {
      entries.push({ type: "message", message });
    }
  }
  return entries;
}

export function patchEntries(
  messages: readonly AgentMessage[],
): readonly AgentMessage[] {
  return [...messages]
    .filter((message) => message.activity?.type === "patch")
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
}

export function partitionSessions(
  sessions: readonly AgentSessionSummary[],
): Readonly<{
  active: readonly AgentSessionSummary[];
  archived: readonly AgentSessionSummary[];
}> {
  const active: AgentSessionSummary[] = [];
  const archived: AgentSessionSummary[] = [];
  for (const session of sessions) {
    (session.archivedAt ? archived : active).push(session);
  }
  return { active, archived };
}

/** Distinct folders from sessions, most recently updated first. */
export function recentFolders(
  sessions: readonly AgentSessionSummary[],
): readonly string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const session of sessions) {
    if (session.folder && !seen.has(session.folder)) {
      seen.add(session.folder);
      folders.push(session.folder);
    }
  }
  return folders;
}

export function folderName(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

const TimelineEntryView: Component<{ entry: TimelineEntry }> = (props) => {
  const { entry } = props;
  if (entry.type === "work") {
    return (
      <details class="work-pane">
        <summary>
          <span class="tool-chevron">›</span>
          {workPaneLabel(entry.startedAt, entry.endedAt)}
        </summary>
        <div class="work-pane-items">
          <For each={entry.entries}>
            {(inner) => <TimelineEntryView entry={inner} />}
          </For>
        </div>
      </details>
    );
  }
  return entry.type === "tools" ? (
    <details class="tool-group">
      <summary>
        <span class="tool-chevron">›</span>
        {toolGroupLabel(entry.messages)}
        <Show
          when={entry.messages.some(({ status }) => status === "streaming")}
        >
          <span class="tool-running" />
        </Show>
      </summary>
      <div class="tool-items">
        <For each={entry.messages}>
          {(message) => (
            <div class="tool-item">
              <strong>
                {message.activity?.type === "tool"
                  ? message.activity.label
                  : "Tool activity"}
              </strong>
              <pre>
                {message.activity?.type === "tool"
                  ? message.activity.detail
                  : message.content}
              </pre>
            </div>
          )}
        </For>
      </div>
    </details>
  ) : entry.message.activity?.type === "commentary" ? (
    <article class="message commentary">
      <pre class="message-body">
        {entry.message.activity.text}
        <Show when={entry.message.status === "streaming"}>
          <span class="streaming-caret" />
        </Show>
      </pre>
    </article>
  ) : (
    <article class={`message ${entry.message.role}`}>
      <Show
        when={entry.message.role === "assistant"}
        fallback={<pre class="message-body">{entry.message.content}</pre>}
      >
        <div
          class="message-body markdown"
          innerHTML={micromark(entry.message.content)}
        />
      </Show>
      <Show when={entry.message.lastError}>
        <div class="message-error">{entry.message.lastError}</div>
      </Show>
    </article>
  );
};

function toolGroupLabel(messages: readonly AgentMessage[]): string {
  const labels = [
    ...new Set(
      messages.flatMap((message) =>
        message.activity?.type === "tool" ? [message.activity.label] : [],
      ),
    ),
  ];
  return labels
    .map((label, index) => (index === 0 ? label : label.toLocaleLowerCase()))
    .join(", ");
}

function describeModel(
  providers: readonly AgentProviderSummary[],
  session: AgentSessionSummary,
): string {
  const provider = providers.find(({ id }) => id === session.providerId);
  const model = provider?.models.find(({ id }) => id === session.modelId);
  return `${provider?.label ?? session.providerId} · ${model?.label ?? session.modelId}`;
}

export const AgentApp: Component<AgentAppProps> = (props) => {
  const [providers, setProviders] = createSignal<
    readonly AgentProviderSummary[]
  >([]);
  const [sessions, setSessions] = createSignal<readonly AgentSessionSummary[]>(
    [],
  );
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [messages, setMessages] = createSignal<readonly AgentMessage[]>([]);
  const [before, setBefore] = createSignal<{
    createdAt: Date;
    id: string;
  } | null>(null);
  const [hasOlder, setHasOlder] = createSignal(false);
  const [loadingFeed, setLoadingFeed] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [prompt, setPrompt] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [providerId, setProviderId] = createSignal("");
  const [modelId, setModelId] = createSignal("");
  const [reasoningEffort, setReasoningEffort] =
    createSignal<AgentReasoningEffort | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [newMode, setNewMode] = createSignal<AgentMode>("incremental");
  const [modeDrafts, setModeDrafts] = createSignal<Record<string, AgentMode>>(
    {},
  );
  const [effortDrafts, setEffortDrafts] = createSignal<
    Record<string, AgentReasoningEffort | null>
  >({});
  const [followupMenuOpen, setFollowupMenuOpen] = createSignal(false);
  const [folderMenuOpen, setFolderMenuOpen] = createSignal(false);
  const recentFoldersList = createMemo(() => recentFolders(sessions()));
  const initialMode = () => selectedMode(providerId(), newMode());
  const followupMode = () => {
    const session = activeSession();
    return selectedMode(
      session?.providerId ?? "",
      session?.mode,
      modeDrafts()[session?.id ?? ""],
    );
  };
  const followupEffort = (): AgentReasoningEffort | null => {
    const session = activeSession();
    const draft = effortDrafts()[session?.id ?? ""];
    return draft !== undefined ? draft : (session?.reasoningEffort ?? null);
  };
  const setFollowupEffort = (effort: AgentReasoningEffort | null): void => {
    if (activeId())
      setEffortDrafts((drafts) => ({ ...drafts, [activeId()!]: effort }));
  };
  const activeSessionModel = () => {
    const session = activeSession();
    const provider = providers().find(({ id }) => id === session?.providerId);
    const model = provider?.models.find(({ id }) => id === session?.modelId);
    return model ? { provider: provider!, model } : null;
  };
  const setMode = (followup: boolean, mode: AgentMode): void => {
    if (followup && activeId())
      setModeDrafts((drafts) => ({ ...drafts, [activeId()!]: mode }));
    else setNewMode(mode);
  };
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const transcriptScroll = createAutoScrollController();
  const patchScroll = createAutoScrollController();
  const narrowPatches = window.matchMedia("(max-width: 1080px)");
  const [patchPanelOpen, setPatchPanelOpen] = createSignal(
    !narrowPatches.matches,
  );
  const [patchPanelWidth, setPatchPanelWidth] = createSignal(520);
  let transcript: HTMLDivElement | undefined;
  let patchList: HTMLDivElement | undefined;
  let modelPicker: HTMLDivElement | undefined;
  let followupPicker: HTMLDivElement | undefined;
  let folderPicker: HTMLDivElement | undefined;
  let feed: AgentMessageFeed | undefined;
  let unsubscribeFeed: (() => void) | undefined;
  let feedGeneration = 0;
  let sessionSequence = -1;

  const resizePatchPanel = (event: PointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = patchPanelWidth();
    const divider = event.currentTarget as HTMLElement;
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-patch-panel");

    const move = (moveEvent: PointerEvent): void => {
      setPatchPanelWidth(
        resizedPatchPanelWidth({
          divider,
          fallbackWidth: window.innerWidth,
          startWidth,
          startX,
          currentX: moveEvent.clientX,
        }),
      );
    };
    const finish = (): void => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      divider.removeEventListener("lostpointercapture", finish);
      if (divider.hasPointerCapture(event.pointerId)) {
        divider.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("resizing-patch-panel");
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
    divider.addEventListener("lostpointercapture", finish);
  };

  const activeSession = createMemo(() =>
    sessions().find(({ id }) => id === activeId()),
  );
  const partitioned = createMemo(() => partitionSessions(sessions()));
  const activeSessions = () => partitioned().active;
  const archivedSessions = () => partitioned().archived;
  const [archivedOpen, setArchivedOpen] = createSignal(false);
  const selectedProvider = createMemo(() =>
    providers().find(({ id }) => id === providerId()),
  );
  const selectedModel = createMemo(() =>
    selectedProvider()?.models.find(({ id }) => id === modelId()),
  );
  const timeline = createMemo(() =>
    collapseWorkRuns(timelineEntries(messages())),
  );
  const patches = createMemo(() => patchEntries(messages()));

  // Latest recorded context usage for the active session, from the most
  // recent assistant message that carries it.
  const latestUsage = createMemo(() => {
    const list = messages();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].usage) return list[i].usage;
    }
    return null;
  });

  const collapsePatchesWhenNarrow = (event: MediaQueryListEvent): void => {
    if (event.matches) setPatchPanelOpen(false);
  };
  narrowPatches.addEventListener("change", collapsePatchesWhenNarrow);

  const closeModelMenuOnPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && !modelPicker?.contains(event.target)) {
      if (modelMenuOpen()) setModelMenuOpen(false);
      if (followupMenuOpen()) setFollowupMenuOpen(false);
    }
    if (
      event.target instanceof Node &&
      !folderPicker?.contains(event.target) &&
      folderMenuOpen()
    ) {
      setFolderMenuOpen(false);
    }
  };
  const closeModelMenuOnKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      setModelMenuOpen(false);
      setFollowupMenuOpen(false);
      setFolderMenuOpen(false);
    }
  };
  document.addEventListener("pointerdown", closeModelMenuOnPointerDown);
  document.addEventListener("keydown", closeModelMenuOnKeyDown);

  createEffect(() => {
    const available = providers();
    if (available.length === 0) return;
    if (!available.some(({ id }) => id === providerId())) {
      setProviderId(available[0].id);
    }
  });
  createEffect(() => {
    const models = selectedProvider()?.models ?? [];
    if (models.length === 0) return;
    if (!models.some(({ id }) => id === modelId())) setModelId(models[0].id);
  });
  createEffect(() => {
    if (folder()) return;
    const latest = recentFoldersList()[0];
    if (latest) setFolder(latest);
  });
  createEffect(() => {
    const model = selectedProvider()?.models.find(({ id }) => id === modelId());
    const efforts = model?.reasoningEfforts ?? [];
    if (efforts.length === 0) {
      setReasoningEffort(null);
    } else if (!reasoningEffort() || !efforts.includes(reasoningEffort()!)) {
      setReasoningEffort(model?.defaultReasoningEffort ?? efforts[0]);
    }
  });

  const showError = (value: unknown): void => {
    setError(value instanceof Error ? value.message : String(value));
  };

  const acceptSessions = (state: {
    sequence: number;
    sessions: readonly AgentSessionSummary[];
  }): void => {
    if (state.sequence < sessionSequence) return;
    sessionSequence = state.sequence;
    setSessions(state.sessions);
  };

  const queueScrollToBottom = (
    controller: ReturnType<typeof createAutoScrollController>,
    container: () => HTMLDivElement | undefined,
  ): void => {
    const current = container();
    if (current && !controller.shouldFollow(current)) return;
    const settle = (frames: number): void => {
      requestAnimationFrame(() => {
        const next = container();
        if (!next || !controller.shouldFollow(next)) return;
        controller.pin();
        next.scrollTop = next.scrollHeight;
        // Tool activity (diffs, code blocks, run collapse) can shift layout
        // a frame or more after the change lands; keep settling briefly.
        if (frames > 0) settle(frames - 1);
      });
    };
    settle(3);
  };

  const followLiveContent = (): void => {
    queueScrollToBottom(transcriptScroll, () => transcript);
    queueScrollToBottom(patchScroll, () => patchList);
  };

  const applyMessageChange = (change: AgentMessageChange): void => {
    setMessages((current) => {
      if (change.type === "message-created") {
        if (current.some(({ id }) => id === change.message.id)) return current;
        return [...current, change.message];
      }
      if (change.type === "message-replaced") {
        return current.map((message) =>
          message.id === change.message.id ? change.message : message,
        );
      }
      return current.map((message) => {
        if (message.id !== change.messageId) return message;
        if (change.type === "content-appended") {
          return {
            ...message,
            content: message.content + change.content,
            updatedAt: change.updatedAt,
          };
        }
        return {
          ...message,
          status: change.status,
          lastError: change.lastError,
          updatedAt: change.updatedAt,
        };
      });
    });
    followLiveContent();
  };

  const closeFeed = (): void => {
    unsubscribeFeed?.();
    unsubscribeFeed = undefined;
    feed?.close();
    feed = undefined;
  };

  const selectSession = async (sessionId: string): Promise<void> => {
    const generation = ++feedGeneration;
    closeFeed();
    setActiveId(sessionId);
    syncHashToSession(sessionId);
    setPrompt("");
    setMessages([]);
    setBefore(null);
    setHasOlder(false);
    setLoadingFeed(true);
    setError(null);
    transcriptScroll.reset();
    patchScroll.reset();
    try {
      const opened = await props.client.openFeed(sessionId, 200);
      if (generation !== feedGeneration) {
        opened.close();
        return;
      }
      feed = opened;
      setMessages(opened.initial.messages);
      setBefore(opened.initial.before);
      setHasOlder(opened.initial.hasOlder);
      unsubscribeFeed = opened.subscribe(applyMessageChange);
      followLiveContent();
    } catch (value) {
      showError(value);
    } finally {
      if (generation === feedGeneration) setLoadingFeed(false);
    }
  };

  const newSession = (): void => {
    feedGeneration += 1;
    closeFeed();
    setActiveId(null);
    syncHashToSession(null);
    setMessages([]);
    setPrompt("");
    setError(null);
    setModelMenuOpen(false);
  };

  const chooseFolder = async (): Promise<void> => {
    setError(null);
    try {
      const result = await props.client.execute({ type: "choose-folder" });
      if (result.type === "folder-selected" && result.folder) {
        setFolder(result.folder);
      }
    } catch (value) {
      showError(value);
    }
  };

  const startSession = async (): Promise<void> => {
    if (!prompt().trim() || !folder() || !providerId() || !modelId()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await props.client.execute({
        type: "start-session",
        prompt: prompt().trim(),
        folder: folder(),
        providerId: providerId(),
        modelId: modelId(),
        reasoningEffort: reasoningEffort(),
        mode: initialMode(),
      });
      if (result.type === "session-started") {
        setPrompt("");
        await selectSession(result.sessionId);
      }
    } catch (value) {
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  const INVESTIGATE_DIRECTIVE =
    "[Investigate only. Do not modify any files; use read-only commands, unless a reversible test is genuinely needed.]";

  const sendMessage = async (
    intent: "implement" | "investigate",
  ): Promise<void> => {
    const sessionId = activeId();
    const content = prompt().trim();
    if (!sessionId || !content || activeSession()?.status === "running") return;
    setSubmitting(true);
    setError(null);
    setPrompt("");
    try {
      await props.client.execute({
        type: "send-message",
        sessionId,
        prompt:
          intent === "investigate"
            ? `${INVESTIGATE_DIRECTIVE}\n\n${content}`
            : content,
        mode: followupMode(),
        reasoningEffort: followupEffort(),
        intent,
      });
    } catch (value) {
      setPrompt(content);
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  const setSessionArchived = async (
    sessionId: string,
    archived: boolean,
  ): Promise<void> => {
    setError(null);
    try {
      await props.client.execute({
        type: archived ? "archive-session" : "unarchive-session",
        sessionId,
      });
    } catch (value) {
      showError(value);
    }
  };

  const loadOlder = async (): Promise<void> => {
    const sessionId = activeId();
    const cursor = before();
    if (!sessionId || !cursor || !hasOlder() || loadingOlder()) return;
    setLoadingOlder(true);
    const oldHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await props.client.loadOlder(sessionId, cursor, 200);
      setMessages((current) => {
        const ids = new Set(current.map(({ id }) => id));
        return [...page.messages.filter(({ id }) => !ids.has(id)), ...current];
      });
      setBefore(page.before);
      setHasOlder(page.hasOlder);
      requestAnimationFrame(() => {
        if (transcript)
          transcript.scrollTop += transcript.scrollHeight - oldHeight;
      });
    } catch (value) {
      showError(value);
    } finally {
      setLoadingOlder(false);
    }
  };

  // If the loaded page fits in the viewport, no scroll event can ever fire,
  // so older pages must be backfilled until the transcript is scrollable.
  createEffect(() => {
    if (!hasOlder() || !before() || loadingOlder() || loadingFeed()) return;
    const element = transcript;
    if (element && element.scrollHeight <= element.clientHeight) {
      void loadOlder();
    }
  });

  const unsubscribeSessions = props.client.subscribeSessions(acceptSessions);
  void Promise.all([props.client.providers(), props.client.sessions()])
    .then(([nextProviders, state]) => {
      setProviders(nextProviders);
      acceptSessions(state);
      const routedId = sessionFromHash();
      if (routedId && state.sessions.some(({ id }) => id === routedId)) {
        void selectSession(routedId);
      }
    })
    .catch(showError);

  onCleanup(() => {
    feedGeneration += 1;
    closeFeed();
    unsubscribeSessions();
    narrowPatches.removeEventListener("change", collapsePatchesWhenNarrow);
    document.removeEventListener("pointerdown", closeModelMenuOnPointerDown);
    document.removeEventListener("keydown", closeModelMenuOnKeyDown);
  });

  return (
    <>
      <style>{agentStyles}</style>
      <div class="agent-app" id="agent-app">
        <code id="main-state" hidden />
        <code id="renderer-state" hidden />
        <div class="window-drag-region" aria-hidden="true" />
        <aside class="agent-sidebar">
          <div class="sidebar-head">
            <div class="brand">
              <span class="brand-mark">H</span>
              <strong>HyOS Agent</strong>
            </div>
            <button class="new-session" type="button" onClick={newSession}>
              ＋ New session
            </button>
          </div>
          <div class="session-label">Sessions</div>
          <div class="session-list" id="agent-session-list">
            <For each={activeSessions()}>
              {(session) => (
                <div
                  class="session-row"
                  classList={{ active: activeId() === session.id }}
                >
                  <button
                    type="button"
                    class="session-open"
                    onClick={() => void selectSession(session.id)}
                  >
                    <span class="session-title">{session.title}</span>
                    <span class="session-meta">
                      <i class={`status-dot ${session.status}`} />
                      {session.modelId}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="session-archive"
                    aria-label={`Archive "${session.title}"`}
                    title="Archive session"
                    onClick={() => void setSessionArchived(session.id, true)}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
            <Show when={archivedSessions().length > 0}>
              <button
                type="button"
                class="session-label archived-label archived-toggle"
                aria-expanded={archivedOpen()}
                onClick={() => setArchivedOpen(!archivedOpen())}
              >
                <i class="archived-chevron">{archivedOpen() ? "▾" : "▸"}</i>
                <span>Archived ({archivedSessions().length})</span>
              </button>
              <Show when={archivedOpen()}>
                <For each={archivedSessions()}>
                  {(session) => (
                    <div
                      class="session-row archived"
                      classList={{ active: activeId() === session.id }}
                    >
                      <button
                        type="button"
                        class="session-open"
                        onClick={() => void selectSession(session.id)}
                      >
                        <span class="session-title">{session.title}</span>
                        <span class="session-meta">
                          <i class={`status-dot ${session.status}`} />
                          {session.modelId}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="session-archive"
                        aria-label={`Unarchive "${session.title}"`}
                        title="Unarchive session"
                        onClick={() =>
                          void setSessionArchived(session.id, false)
                        }
                      >
                        ↩
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </aside>

        <main class="agent-main">
          <Show
            when={activeSession()}
            fallback={
              <section class="welcome">
                <div class="welcome-card">
                  <h2 class="welcome-title">New session</h2>
                  <div class="starter">
                    <textarea
                      id="agent-start-prompt"
                      class="prompt"
                      value={prompt()}
                      onInput={(event) => setPrompt(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void startSession();
                        }
                      }}
                      placeholder="What do you want to work on?"
                      autofocus
                    />
                    <div class="starter-controls">
                      <div class="folder-picker" ref={folderPicker}>
                        <button
                          class="folder-button"
                          type="button"
                          aria-label="Choose folder"
                          aria-haspopup="dialog"
                          aria-expanded={folderMenuOpen()}
                          onClick={() => setFolderMenuOpen((open) => !open)}
                          title={folder() || "Choose folder"}
                        >
                          {folder() ? folderName(folder()) : "Choose folder"}
                          <i aria-hidden="true">▾</i>
                        </button>
                        <Show when={folderMenuOpen()}>
                          <div
                            class="folder-menu"
                            role="dialog"
                            aria-label="Choose folder"
                          >
                            <button
                              class="folder-menu-new"
                              type="button"
                              onClick={() => {
                                setFolderMenuOpen(false);
                                void chooseFolder();
                              }}
                            >
                              Choose new folder…
                            </button>
                            <Show
                              when={recentFoldersList().length > 0}
                              fallback={
                                <div class="folder-menu-empty">
                                  No recent folders
                                </div>
                              }
                            >
                              <div class="folder-menu-list">
                                <For each={recentFoldersList()}>
                                  {(recent) => (
                                    <button
                                      class="folder-menu-item"
                                      type="button"
                                      classList={{
                                        selected: recent === folder(),
                                      }}
                                      title={recent}
                                      onClick={() => {
                                        setFolder(recent);
                                        setFolderMenuOpen(false);
                                      }}
                                    >
                                      {folderName(recent)}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                      <div class="model-picker" ref={modelPicker}>
                        <button
                          id="agent-model-picker"
                          class="model-picker-trigger"
                          type="button"
                          aria-label="Choose model"
                          aria-haspopup="dialog"
                          aria-expanded={modelMenuOpen()}
                          onClick={() => setModelMenuOpen((open) => !open)}
                        >
                          <span>
                            {selectedModel()?.label ?? "Choose model"}
                          </span>
                          <Show
                            when={
                              initialMode() === "incremental"
                                ? "incremental"
                                : reasoningEffort()
                            }
                          >
                            {(effort) => <small>· {effort()}</small>}
                          </Show>
                          <i aria-hidden="true">▾</i>
                        </button>
                        <Show when={modelMenuOpen()}>
                          <div
                            class="model-menu"
                            role="dialog"
                            aria-label="Model settings"
                          >
                            <div class="model-menu-title">Choose a model</div>
                            <div class="model-menu-list">
                              <For each={providers()}>
                                {(provider) => (
                                  <section class="model-provider-group">
                                    <div class="model-provider-label">
                                      {provider.label}
                                    </div>
                                    <For each={provider.models}>
                                      {(model) => (
                                        <button
                                          type="button"
                                          class="model-option"
                                          classList={{
                                            selected:
                                              provider.id === providerId() &&
                                              model.id === modelId(),
                                          }}
                                          onClick={() => {
                                            setProviderId(provider.id);
                                            setModelId(model.id);
                                          }}
                                        >
                                          <span>{model.label}</span>
                                          <Show
                                            when={
                                              provider.id === providerId() &&
                                              model.id === modelId()
                                            }
                                          >
                                            <i aria-hidden="true">✓</i>
                                          </Show>
                                        </button>
                                      )}
                                    </For>
                                  </section>
                                )}
                              </For>
                            </div>
                            <Show when={selectedModel()?.reasoningEfforts}>
                              {(efforts) => (
                                <div class="reasoning-picker">
                                  <span>Reasoning</span>
                                  <div class="reasoning-options">
                                    <Show when={providerId() === "glm"}>
                                      <button
                                        type="button"
                                        class="incremental-option"
                                        classList={{
                                          selected:
                                            initialMode() === "incremental",
                                        }}
                                        title="Work in small, reviewable iterations with low reasoning. Saved when you send."
                                        onClick={() => {
                                          setMode(false, "incremental");
                                          setReasoningEffort("low");
                                        }}
                                      >
                                        incremental
                                      </button>
                                    </Show>
                                    <For each={efforts()}>
                                      {(effort) => (
                                        <button
                                          type="button"
                                          classList={{
                                            selected:
                                              initialMode() === "incremental"
                                                ? false
                                                : reasoningEffort() === effort,
                                          }}
                                          onClick={() => {
                                            setReasoningEffort(effort);
                                            if (initialMode() === "incremental")
                                              setMode(false, "standard");
                                          }}
                                        >
                                          {effort}
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              )}
                            </Show>
                          </div>
                        </Show>
                      </div>
                      <button
                        id="agent-start"
                        class="primary"
                        type="button"
                        disabled={
                          submitting() ||
                          !prompt().trim() ||
                          !folder() ||
                          !modelId()
                        }
                        onClick={() => void startSession()}
                      >
                        {submitting() ? "Starting…" : "Start session"}
                      </button>
                    </div>
                    <Show when={error()}>
                      {(value) => <div class="inline-error">{value()}</div>}
                    </Show>
                  </div>
                </div>
              </section>
            }
          >
            {(session) => (
              <section
                class="conversation"
                classList={{ "patch-panel-open": patchPanelOpen() }}
                style={`--patch-panel-width: ${patchPanelWidth()}px`}
              >
                <header class="conversation-head">
                  <div class="conversation-title">
                    <strong>{session().title}</strong>
                    <span>
                      {describeModel(providers(), session())} ·{" "}
                      {session().folder}
                    </span>
                  </div>
                  <Show when={session().status === "running"}>
                    <button
                      class="cancel"
                      type="button"
                      onClick={() =>
                        void props.client.execute({
                          type: "cancel",
                          sessionId: session().id,
                        })
                      }
                    >
                      Stop
                    </button>
                  </Show>
                  <button
                    class="patch-toggle"
                    classList={{ active: patchPanelOpen() }}
                    type="button"
                    aria-expanded={patchPanelOpen()}
                    aria-controls="agent-patch-feed"
                    onClick={() => {
                      const opening = !patchPanelOpen();
                      setPatchPanelOpen(opening);
                      if (opening) {
                        patchScroll.reset();
                        queueScrollToBottom(patchScroll, () => patchList);
                      }
                    }}
                  >
                    Patches <span>{patches().length}</span>
                  </button>
                </header>
                <div
                  class="transcript"
                  ref={transcript}
                  onScroll={() => {
                    if (transcript) transcriptScroll.observeScroll(transcript);
                    if ((transcript?.scrollTop ?? 999) < 120) void loadOlder();
                  }}
                >
                  <div class="messages">
                    <Show when={loadingOlder()}>
                      <div class="loading-older">Loading earlier messages…</div>
                    </Show>
                    <Show when={loadingFeed()}>
                      <div class="loading-older">Loading session…</div>
                    </Show>
                    <For each={timeline()}>
                      {(entry) => <TimelineEntryView entry={entry} />}
                    </For>
                    <Show when={error()}>
                      {(value) => <div class="inline-error">{value()}</div>}
                    </Show>
                  </div>
                </div>
                <div class="composer-shell">
                  <div class="composer">
                    <textarea
                      aria-label="Message the agent"
                      value={prompt()}
                      onInput={(event) => setPrompt(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void sendMessage("implement");
                        }
                      }}
                      placeholder={
                        session().status === "running"
                          ? "Agent is working…"
                          : "Send another instruction…"
                      }
                      disabled={session().status === "running"}
                    />
                    <div class="composer-bar">
                      <Show when={activeSessionModel()?.model.reasoningEfforts}>
                        {(efforts) => (
                          <div class="model-picker" ref={followupPicker}>
                            <button
                              class="model-picker-trigger"
                              type="button"
                              aria-label="Adjust reasoning for this session"
                              aria-haspopup="dialog"
                              aria-expanded={followupMenuOpen()}
                              disabled={session().status === "running"}
                              onClick={() =>
                                setFollowupMenuOpen((open) => !open)
                              }
                            >
                              <span>
                                {activeSessionModel()?.model.label ??
                                  session().modelId}
                              </span>
                              <Show
                                when={
                                  followupMode() === "incremental"
                                    ? "incremental"
                                    : followupEffort()
                                }
                              >
                                {(label) => <small>· {label()}</small>}
                              </Show>
                              <i aria-hidden="true">▾</i>
                            </button>
                            <Show when={followupMenuOpen()}>
                              <div
                                class="model-menu"
                                role="dialog"
                                aria-label="Reasoning settings"
                              >
                                <div class="model-menu-title">
                                  {activeSessionModel()?.provider.label} ·{" "}
                                  {activeSessionModel()?.model.label}
                                </div>
                                <div class="reasoning-picker">
                                  <span>Reasoning</span>
                                  <div class="reasoning-options">
                                    <Show when={session().providerId === "glm"}>
                                      <button
                                        type="button"
                                        class="incremental-option"
                                        classList={{
                                          selected:
                                            followupMode() === "incremental",
                                        }}
                                        title="Work in small, reviewable iterations with low reasoning. Saved when you send."
                                        onClick={() => {
                                          setMode(true, "incremental");
                                          setFollowupEffort("low");
                                        }}
                                      >
                                        incremental
                                      </button>
                                    </Show>
                                    <For each={efforts()}>
                                      {(effort) => (
                                        <button
                                          type="button"
                                          classList={{
                                            selected:
                                              followupMode() === "incremental"
                                                ? false
                                                : followupEffort() === effort,
                                          }}
                                          onClick={() => {
                                            setFollowupEffort(effort);
                                            if (
                                              followupMode() === "incremental"
                                            )
                                              setMode(true, "standard");
                                          }}
                                        >
                                          {effort}
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>
                      <Show when={latestUsage()}>
                        {(usage) => (
                          <span
                            class="context-usage"
                            title="Context window usage from the last completed turn"
                          >
                            {usage().promptTokens.toLocaleString("en-US")} /{" "}
                            {usage().contextWindow.toLocaleString("en-US")}
                          </span>
                        )}
                      </Show>
                      <div class="composer-actions">
                        <button
                          class="send investigate"
                          type="button"
                          title="Read-only run: no file changes unless a reversible test is needed"
                          onClick={() => void sendMessage("investigate")}
                          disabled={
                            submitting() ||
                            session().status === "running" ||
                            !prompt().trim()
                          }
                        >
                          Investigate
                        </button>
                        <button
                          class="send"
                          type="button"
                          onClick={() => void sendMessage("implement")}
                          disabled={
                            submitting() ||
                            session().status === "running" ||
                            !prompt().trim()
                          }
                        >
                          Implement
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <Show when={patchPanelOpen()}>
                  <aside class="patch-feed" id="agent-patch-feed">
                    <div
                      class="patch-resize-handle"
                      role="separator"
                      aria-label="Resize patch feed"
                      aria-orientation="vertical"
                      aria-valuemin="360"
                      aria-valuenow={patchPanelWidth()}
                      onPointerDown={resizePatchPanel}
                    />
                    <div class="patch-feed-head">
                      <div>
                        <strong>Patches</strong>
                        <span>{patches().length} in loaded history</span>
                      </div>
                      <button
                        type="button"
                        aria-label="Collapse patch feed"
                        onClick={() => setPatchPanelOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div
                      class="patch-list"
                      ref={patchList}
                      onScroll={() => {
                        if (patchList) patchScroll.observeScroll(patchList);
                      }}
                    >
                      <Show
                        when={patches().length > 0}
                        fallback={
                          <div class="patch-empty">
                            File changes will appear here as the agent works.
                          </div>
                        }
                      >
                        <For each={patches()}>
                          {(message) => (
                            <div class="patch-entry">
                              <p>
                                {message.activity?.type === "patch" &&
                                  message.activity.explanation}
                              </p>
                              <div class="patch-files">
                                <For
                                  each={
                                    message.activity?.type === "patch"
                                      ? message.activity.changes
                                      : []
                                  }
                                >
                                  {(change) => (
                                    <span title={change.path}>
                                      <i>{change.kind}</i> {change.path}
                                    </span>
                                  )}
                                </For>
                              </div>
                              <Show
                                when={
                                  message.activity?.type === "patch" &&
                                  message.activity.diff
                                }
                              >
                                <DiffViewer
                                  diff={
                                    message.activity?.type === "patch"
                                      ? message.activity.diff
                                      : ""
                                  }
                                  paths={
                                    message.activity?.type === "patch"
                                      ? message.activity.changes.map(
                                          ({ path }) => path,
                                        )
                                      : []
                                  }
                                  loadFile={(path) =>
                                    props.client.readFile(session().id, path)
                                  }
                                />
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </aside>
                </Show>
              </section>
            )}
          </Show>
        </main>
      </div>
    </>
  );
};
