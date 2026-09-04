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

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
}>;

type TimelineEntry =
  | Readonly<{ type: "message"; message: AgentMessage }>
  | Readonly<{ type: "tools"; messages: readonly AgentMessage[] }>;

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
  const selectedProvider = createMemo(() =>
    providers().find(({ id }) => id === providerId()),
  );
  const selectedModel = createMemo(() =>
    selectedProvider()?.models.find(({ id }) => id === modelId()),
  );
  const timeline = createMemo(() => timelineEntries(messages()));
  const patches = createMemo(() => patchEntries(messages()));

  const collapsePatchesWhenNarrow = (event: MediaQueryListEvent): void => {
    if (event.matches) setPatchPanelOpen(false);
  };
  narrowPatches.addEventListener("change", collapsePatchesWhenNarrow);

  const closeModelMenuOnPointerDown = (event: PointerEvent): void => {
    if (
      modelMenuOpen() &&
      event.target instanceof Node &&
      !modelPicker?.contains(event.target)
    ) {
      setModelMenuOpen(false);
    }
  };
  const closeModelMenuOnKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") setModelMenuOpen(false);
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
    requestAnimationFrame(() => {
      const next = container();
      if (!next || !controller.shouldFollow(next)) return;
      next.scrollTop = next.scrollHeight;
    });
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
    setPrompt("");
    setMessages([]);
    setBefore(null);
    setHasOlder(false);
    setLoadingFeed(true);
    setError(null);
    transcriptScroll.reset();
    patchScroll.reset();
    try {
      const opened = await props.client.openFeed(sessionId, 30);
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

  const sendMessage = async (): Promise<void> => {
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
        prompt: content,
      });
    } catch (value) {
      setPrompt(content);
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  const loadOlder = async (): Promise<void> => {
    const sessionId = activeId();
    const cursor = before();
    if (!sessionId || !cursor || !hasOlder() || loadingOlder()) return;
    setLoadingOlder(true);
    const oldHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await props.client.loadOlder(sessionId, cursor, 30);
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

  const unsubscribeSessions = props.client.subscribeSessions(acceptSessions);
  void Promise.all([props.client.providers(), props.client.sessions()])
    .then(([nextProviders, state]) => {
      setProviders(nextProviders);
      acceptSessions(state);
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
            <For each={sessions()}>
              {(session) => (
                <button
                  type="button"
                  class="session-row"
                  classList={{ active: activeId() === session.id }}
                  onClick={() => void selectSession(session.id)}
                >
                  <span class="session-title">{session.title}</span>
                  <span class="session-meta">
                    <i class={`status-dot ${session.status}`} />
                    {session.modelId}
                  </span>
                </button>
              )}
            </For>
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
                      <button
                        class="folder-button"
                        type="button"
                        onClick={() => void chooseFolder()}
                        title={folder() || "Choose folder"}
                      >
                        {folder() || "Choose folder"}
                      </button>
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
                          <Show when={reasoningEffort()}>
                            {(effort) => <small>· {effort()}</small>}
                          </Show>
                          <i aria-hidden="true">⌄</i>
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
                                    <For each={efforts()}>
                                      {(effort) => (
                                        <button
                                          type="button"
                                          classList={{
                                            selected:
                                              reasoningEffort() === effort,
                                          }}
                                          onClick={() =>
                                            setReasoningEffort(effort)
                                          }
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
                      {(entry) =>
                        entry.type === "tools" ? (
                          <details class="tool-group">
                            <summary>
                              <span class="tool-chevron">›</span>
                              {toolGroupLabel(entry.messages)}
                              <Show
                                when={entry.messages.some(
                                  ({ status }) => status === "streaming",
                                )}
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
                              fallback={
                                <pre class="message-body">
                                  {entry.message.content}
                                </pre>
                              }
                            >
                              <div
                                class="message-body markdown"
                                innerHTML={micromark(entry.message.content)}
                              />
                            </Show>
                            <Show when={entry.message.lastError}>
                              <div class="message-error">
                                {entry.message.lastError}
                              </div>
                            </Show>
                          </article>
                        )
                      }
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
                          void sendMessage();
                        }
                      }}
                      placeholder={
                        session().status === "running"
                          ? "Agent is working…"
                          : "Send another instruction…"
                      }
                      disabled={session().status === "running"}
                    />
                    <button
                      class="send"
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={
                        submitting() ||
                        session().status === "running" ||
                        !prompt().trim()
                      }
                    >
                      Send
                    </button>
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
