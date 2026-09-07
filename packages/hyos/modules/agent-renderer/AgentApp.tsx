import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";

import type {
  AgentMessage,
  AgentPlan,
  AgentPlanTask,
  AgentProviderSummary,
  AgentSessionSummary,
} from "../../capabilities/agent.js";
import { stripPlanBlocks } from "../../capabilities/plan.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import type { AgentClient } from "./client.js";
import { BrowserTabContent } from "./browser-tab.js";
import { DiffViewer } from "./DiffViewer.js";
import { mountMarkdown } from "./markdown.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import {
  isPinnedSideTab,
  sideTabDescriptors,
  sideTabLabel,
} from "./side-pane.js";
import { globalTabLabel } from "./global-tabs.js";
import { agentStyles } from "./styles.js";
import { supportsIncremental } from "./mode-selection.js";
import { createAppState } from "./app-state.js";

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
  browserClient: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
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

/**
 * Index of the timeline entry the plan panel belongs under — the final
 * assistant response — or -1 when there is nothing to attach it to.
 * Streaming turns attach nothing: thinking/commentary messages stream in
 * as assistant messages too, so matching them would move the panel around
 * mid-run.
 */
export function planPanelIndex(entries: readonly TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.status !== "streaming"
    ) {
      return index;
    }
  }
  return -1;
}

/** The first pending plan task, or null when every task is done. */
export function nextPlanTask(
  tasks: readonly AgentPlanTask[],
): AgentPlanTask | null {
  return tasks.find((task) => !task.done) ?? null;
}

/** The user response that drives the next "implement next" iteration. */
export function implementNextPrompt(
  index: number,
  task: AgentPlanTask,
): string {
  return `Implement next: complete and verify only task ${index + 1} of the plan — "${task.text}". Do not work on any other task or expand the plan, and end with the updated hyos-plan block marking this task done.`;
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

export type SessionFolderGroup = Readonly<{
  folder: string;
  label: string;
  parentPath: string | null;
  sessions: readonly AgentSessionSummary[];
}>;

/** Group a newest-first session list, preserving group and session order.
 * Call separately for active and archived sessions after partitioning.
 */
export function groupSessionsByFolder(
  sessions: readonly AgentSessionSummary[],
): readonly SessionFolderGroup[] {
  const folders = new Map<string, AgentSessionSummary[]>();
  for (const session of sessions) {
    const group = folders.get(session.folder);
    if (group) group.push(session);
    else folders.set(session.folder, [session]);
  }
  const labels = new Map<string, number>();
  const labelFor = (folder: string) =>
    folder ? folderName(folder) || folder : "No project folder";
  for (const folder of folders.keys()) {
    const label = labelFor(folder);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return Array.from(folders, ([folder, groupedSessions]) => {
    const label = labelFor(folder);
    const trimmed = folder.replace(/\/+$/, "");
    const separator = trimmed.lastIndexOf("/");
    return {
      folder,
      label,
      parentPath:
        folder && labels.get(label)! > 1
          ? separator === -1
            ? "."
            : trimmed.slice(0, separator) || "/"
          : null,
      sessions: groupedSessions,
    };
  });
}

const SessionFolderList: Component<{
  sessions: readonly AgentSessionSummary[];
  children: (session: AgentSessionSummary) => JSX.Element;
}> = (props) => {
  const groups = createMemo(() => groupSessionsByFolder(props.sessions));
  return (
    <For each={groups()}>
      {(group) => (
        <section
          class="session-folder-group"
          aria-label={group.folder || group.label}
        >
          <h3
            class="session-folder-heading"
            title={group.folder || group.label}
          >
            <span class="session-folder-name">{group.label}</span>
            <Show when={group.parentPath}>
              <span class="session-folder-parent">{group.parentPath}</span>
            </Show>
          </h3>
          <For each={group.sessions}>{props.children}</For>
        </section>
      )}
    </For>
  );
};

/** Distinct folders from sessions, in first-seen session order. */
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

const FOLDER_ORDER_KEY = "hyos.sidebar-folder-order";

/** Read the persisted folder order, if any. */
export function loadFolderOrder(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): readonly string[] | null {
  try {
    const raw = storage.getItem(FOLDER_ORDER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

/** Persist a folder order. */
export function saveFolderOrder(
  order: readonly string[],
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(FOLDER_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Storage unavailable (private mode, quota); order just won't persist.
  }
}

/**
 * Apply a saved manual order to the recent folders: saved folders keep their
 * order, folders not in the saved order (new ones) append at the end.
 */
export function orderedFolders(
  recent: readonly string[],
  savedOrder: readonly string[] | null,
): readonly string[] {
  if (!savedOrder || savedOrder.length === 0) return recent;
  const known = new Set(recent);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const folder of savedOrder) {
    if (known.has(folder) && !seen.has(folder)) {
      seen.add(folder);
      ordered.push(folder);
    }
  }
  for (const folder of recent) {
    if (!seen.has(folder)) {
      seen.add(folder);
      ordered.push(folder);
    }
  }
  return ordered;
}

export function folderName(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

const MarkdownBody: Component<{ content: string }> = (props) => {
  let element!: HTMLDivElement;
  createEffect(() => {
    // Plan blocks are persisted on the session and rendered as structured
    // task lists; keep them out of the markdown body.
    const dispose = mountMarkdown(element, stripPlanBlocks(props.content));
    onCleanup(dispose);
  });
  return <div class="message-body markdown" ref={element} />;
};

const PlanPanel: Component<{
  plan: AgentPlan;
  disabled: boolean;
  onImplementNext: (index: number, task: AgentPlanTask) => void;
}> = (props) => {
  const nextIndex = () => props.plan.tasks.findIndex((task) => !task.done);
  return (
    <aside class="plan-panel" aria-label="Session plan">
      <div class="plan-head">
        <strong>Plan</strong>
        <span>
          {props.plan.tasks.filter((task) => task.done).length}/
          {props.plan.tasks.length} done
        </span>
      </div>
      <div class="plan-tasks">
        <For each={props.plan.tasks}>
          {(task, index) => (
            <>
              <div
                classList={{
                  "plan-task": true,
                  done: task.done,
                  next: index() === nextIndex(),
                }}
              >
                <span class="plan-num" aria-hidden="true">
                  {index() + 1}.
                </span>
                <span class="plan-check" aria-hidden="true">
                  {task.done ? "✓" : ""}
                </span>
                <span class="plan-text">{task.text}</span>
              </div>
              <Show when={index() === nextIndex()}>
                <button
                  class="plan-next"
                  type="button"
                  disabled={props.disabled}
                  title={implementNextPrompt(index(), task)}
                  onClick={() => props.onImplementNext(index(), task)}
                >
                  Implement task
                </button>
              </Show>
            </>
          )}
        </For>
      </div>
    </aside>
  );
};

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
      <MarkdownBody content={entry.message.activity.text} />
      <Show when={entry.message.status === "streaming"}>
        <span class="streaming-caret" />
      </Show>
    </article>
  ) : (
    <article class={`message ${entry.message.role}`}>
      <Show
        when={entry.message.role === "assistant"}
        fallback={<pre class="message-body">{entry.message.content}</pre>}
      >
        <MarkdownBody content={entry.message.content} />
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
  console.log("[DEBUG-boot-7f2c] agent-renderer component:construct");
  const {
    providers,
    activeId,
    prompt,
    setPrompt,
    folder,
    setFolder,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    reasoningEffort,
    setReasoningEffort,
    initialMode,
    followupMode,
    followupEffort,
    setFollowupEffort,
    activeSessionModel,
    setMode,
    submitting,
    error,
    recentFoldersList,
    modelMenuOpen,
    setModelMenuOpen,
    followupMenuOpen,
    setFollowupMenuOpen,
    folderMenuOpen,
    setFolderMenuOpen,
    archivedOpen,
    setArchivedOpen,
    selectedModel,
    loadingFeed,
    loadingOlder,
    timeline,
    patches,
    latestUsage,
    activeSession,
    activeSessions,
    archivedSessions,
    activePlan,
    planAfterIndex,
    browserState,
    browserError,
    runBrowser,
    sideCollapsed,
    setSideCollapsed,
    sideTabs,
    activeSideTabId,
    setActiveSideTabId,
    sideActive,
    activeBrowserTab,
    openBrowserSideTab,
    closeSideTab,
    globalTabs,
    setActiveGlobalTabId,
    focusedGlobalTab,
    openGlobalTab,
    closeGlobalTab,
    transcriptScroll,
    patchScroll,
    setTranscriptElement,
    setPatchListElement,
    transcriptElement,
    patchListElement,
    loadOlder,
    selectSession,
    newSession,
    chooseFolder,
    startSession,
    sendMessage,
    implementNext,
    setSessionArchived,
  } = createAppState({
    client: props.client,
    browserClient: props.browserClient,
  });

  const [patchPanelWidth, setPatchPanelWidth] = createSignal(520);
  let modelPicker: HTMLDivElement | undefined;
  let followupPicker: HTMLDivElement | undefined;
  let folderPicker: HTMLDivElement | undefined;

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
  onCleanup(() => {
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
              <strong>hyos</strong>
            </div>
            <button
              class="new-session"
              classList={{ open: !activeSession() }}
              type="button"
              onClick={newSession}
            >
              <svg
                class="new-session-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                {/* lucide square-pen */}
                <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
              </svg>
              New session
            </button>
          </div>
          <div class="global-tabs" aria-label="Global tabs">
            <div class="global-tabs-head">
              <span class="session-label global-tabs-label">Tabs</span>
              <button
                type="button"
                class="side-tab-add global-tab-add"
                aria-label="Open global browser tab"
                title="Open global browser tab"
                onClick={openGlobalTab}
              >
                +
              </button>
            </div>
            <Show when={globalTabs().length > 0}>
              <div class="global-tab-list" role="tablist">
                <For each={globalTabs()}>
                  {(tab) => (
                    <div
                      class="global-tab-row"
                      classList={{
                        active: focusedGlobalTab()?.id === tab.id,
                      }}
                    >
                      <button
                        type="button"
                        role="tab"
                        class="global-tab"
                        aria-selected={focusedGlobalTab()?.id === tab.id}
                        title={globalTabLabel(tab, browserState())}
                        onClick={() => setActiveGlobalTabId(tab.id)}
                      >
                        <span class="side-tab-icon" aria-hidden="true">
                          ◉
                        </span>
                        <span class="side-tab-label">
                          {globalTabLabel(tab, browserState())}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="global-tab-close"
                        aria-label={`Close ${globalTabLabel(tab, browserState())}`}
                        title="Close tab"
                        onClick={() => closeGlobalTab(tab)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="session-label">Sessions</div>
          <div class="session-list" id="agent-session-list">
            <SessionFolderList sessions={activeSessions()}>
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
            </SessionFolderList>
            <Show when={archivedSessions().length > 0}>
              <button
                type="button"
                class="session-label archived-label archived-toggle"
                aria-expanded={archivedOpen()}
                onClick={() => setArchivedOpen(!archivedOpen())}
              >
                <span>Archived ({archivedSessions().length})</span>
                <i class="archived-chevron">{archivedOpen() ? "▾" : "▸"}</i>
              </button>
              <Show when={archivedOpen()}>
                <SessionFolderList sessions={archivedSessions()}>
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
                </SessionFolderList>
              </Show>
            </Show>
          </div>
        </aside>

        <main class="agent-main">
          <Show when={focusedGlobalTab()} keyed>
            {(tab) => (
              <section class="global-browser" aria-label="Global browser tab">
                <BrowserTabContent
                  root={props.root}
                  state={browserState()}
                  tabId={tab.tabId}
                  error={browserError()}
                  onCommand={(command) => void runBrowser(command)}
                  BrowserView={props.BrowserView}
                />
              </section>
            )}
          </Show>
          <Show
            when={!focusedGlobalTab() && activeSession()}
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
                                    <Show
                                      when={supportsIncremental(providerId())}
                                    >
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
                classList={{
                  "side-open": !sideCollapsed(),
                  "side-collapsed": sideCollapsed(),
                }}
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
                </header>
                <div
                  class="transcript"
                  ref={setTranscriptElement}
                  onScroll={() => {
                    const element = transcriptElement();
                    if (element) transcriptScroll.observeScroll(element);
                    if ((element?.scrollTop ?? 999) < 120) void loadOlder();
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
                      {(entry, index) => (
                        <>
                          <TimelineEntryView entry={entry} />
                          <Show
                            when={
                              activePlan() &&
                              session().status !== "running" &&
                              index() === planAfterIndex()
                            }
                          >
                            <PlanPanel
                              plan={activePlan()!}
                              disabled={
                                submitting() || session().status === "running"
                              }
                              onImplementNext={(taskIndex, task) =>
                                void implementNext(taskIndex, task)
                              }
                            />
                          </Show>
                        </>
                      )}
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
                                    <Show
                                      when={supportsIncremental(
                                        session().providerId,
                                      )}
                                    >
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
                <aside
                  class="side-pane"
                  classList={{ collapsed: sideCollapsed() }}
                  aria-label="Session panels"
                >
                  <div
                    class="patch-resize-handle"
                    role="separator"
                    aria-label="Resize side pane"
                    aria-orientation="vertical"
                    aria-valuemin="360"
                    aria-valuenow={patchPanelWidth()}
                    onPointerDown={resizePatchPanel}
                  />
                  <div
                    class="side-tabs"
                    role="tablist"
                    aria-label="Side panels"
                  >
                    <For each={sideTabs()}>
                      {(tab) => (
                        <button
                          type="button"
                          role="tab"
                          class="side-tab"
                          classList={{ active: sideActive()?.id === tab.id }}
                          aria-selected={sideActive()?.id === tab.id}
                          aria-controls="agent-side-pane-content"
                          title={sideTabLabel(tab, browserState())}
                          onClick={() => {
                            setActiveSideTabId(tab.id);
                            setSideCollapsed(false);
                          }}
                        >
                          <span class="side-tab-icon" aria-hidden="true">
                            {sideTabDescriptors[tab.kind].icon}
                          </span>
                          <span class="side-tab-label">
                            {sideTabLabel(tab, browserState())}
                          </span>
                          <Show when={tab.kind === "patches"}>
                            <span class="side-tab-badge">
                              {patches().length}
                            </span>
                          </Show>
                          <Show when={!isPinnedSideTab(tab)}>
                            <span
                              class="side-tab-close"
                              role="button"
                              tabindex="0"
                              aria-label={`Close ${sideTabLabel(tab, browserState())}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                closeSideTab(tab);
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  closeSideTab(tab);
                                }
                              }}
                            >
                              ×
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                    <button
                      type="button"
                      class="side-tab-add"
                      aria-label="Open browser tab"
                      title="Open browser tab"
                      onClick={() => openBrowserSideTab()}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      class="side-collapse"
                      aria-label={
                        sideCollapsed()
                          ? "Expand side pane"
                          : "Collapse side pane"
                      }
                      aria-expanded={!sideCollapsed()}
                      onClick={() =>
                        setSideCollapsed((collapsed) => !collapsed)
                      }
                    >
                      {sideCollapsed() ? "«" : "»"}
                    </button>
                  </div>
                  <div class="side-pane-body" id="agent-side-pane-content">
                    <Show when={sideActive()?.kind === "patches"}>
                      <div
                        class="patch-list"
                        ref={setPatchListElement}
                        onScroll={() => {
                          const element = patchListElement();
                          if (element) patchScroll.observeScroll(element);
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
                    </Show>
                    <Show when={activeBrowserTab()} keyed>
                      {(tab) => (
                        <BrowserTabContent
                          root={props.root}
                          state={browserState()}
                          tabId={tab.tabId}
                          error={browserError()}
                          onCommand={(command) => void runBrowser(command)}
                          BrowserView={props.BrowserView}
                        />
                      )}
                    </Show>
                  </div>
                </aside>
              </section>
            )}
          </Show>
        </main>
      </div>
    </>
  );
};
