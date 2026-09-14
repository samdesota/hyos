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
import type { AgentClient } from "./client.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { BrowserTabContent } from "./browser-tab.js";
import { DiffViewer } from "./DiffViewer.js";
import { httpLinkUrl, mountMarkdown } from "./markdown.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import { supportsIncremental } from "./mode-selection.js";
import {
  isPinnedSideTab,
  sideTabDescriptors,
  sideTabLabel,
} from "./side-pane.js";
import type { AppState } from "./app-state.js";
import {
  implementNextPrompt,
  workPaneLabel,
  type TimelineEntry,
} from "./sessions-model.js";

export type SessionPageProps = Readonly<{
  app: AppState;
  client: AgentClient;
  session: () => AgentSessionSummary;
  root: Document;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

const MarkdownBody: Component<{ content: string; app: AppState }> = (props) => {
  let element!: HTMLDivElement;
  // Links in agent replies open as browser tabs in the session's side panel
  // instead of navigating the agent renderer itself.
  const handleClick = (event: MouseEvent): void => {
    const url = httpLinkUrl(event);
    if (!url) return;
    event.preventDefault();
    props.app.openUrlSideTab(url);
  };
  createEffect(() => {
    // Plan blocks are persisted on the session and rendered as structured
    // task lists; keep them out of the markdown body.
    const dispose = mountMarkdown(element, stripPlanBlocks(props.content));
    onCleanup(dispose);
  });
  return (
    <div class="message-body markdown" ref={element} onClick={handleClick} />
  );
};

const PlanPanel: Component<{
  plan: AgentPlan;
  disabled: boolean;
  onImplementNext: (index: number, task: AgentPlanTask) => void;
}> = (props) => {
  const nextIndex = () => props.plan.tasks.findIndex((task) => !task.done);
  const [expanded, setExpanded] = createSignal(false);
  // Collapsed view keeps only the last two completed tasks visible; earlier
  // completed tasks are hidden behind a fade-out with a "Show all" button.
  const doneIndices = () =>
    props.plan.tasks.flatMap((task, index) => (task.done ? [index] : []));
  // Once every task is done, always show the full list.
  const allDone = () =>
    props.plan.tasks.length > 0 &&
    doneIndices().length === props.plan.tasks.length;
  const hiddenCount = () =>
    allDone() ? 0 : Math.max(0, doneIndices().length - 2);
  const isHidden = (index: number) =>
    !expanded() && doneIndices().slice(0, hiddenCount()).includes(index);
  return (
    <aside class="plan-panel" aria-label="Session plan">
      <div class="plan-head">
        <strong>Plan</strong>
        <span>
          {props.plan.tasks.filter((task) => task.done).length}/
          {props.plan.tasks.length} done
        </span>
      </div>
      <Show when={hiddenCount() > 0 && !expanded()}>
        <button
          class="plan-show-all"
          type="button"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount()} earlier task{hiddenCount() === 1 ? "" : "s"}
        </button>
      </Show>
      <div
        classList={{
          "plan-tasks": true,
          faded: hiddenCount() > 0 && !expanded(),
        }}
      >
        <For each={props.plan.tasks}>
          {(task, index) => (
            <Show when={!isHidden(index())}>
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
            </Show>
          )}
        </For>
      </div>
    </aside>
  );
};

const TimelineEntryView: Component<{
  entry: TimelineEntry;
  app: AppState;
}> = (props) => {
  const { entry, app } = props;
  if (entry.type === "work") {
    return (
      <details class="work-pane">
        <summary>
          <span class="tool-chevron">›</span>
          {workPaneLabel(entry.startedAt, entry.endedAt)}
        </summary>
        <div class="work-pane-items">
          <For each={entry.entries}>
            {(inner) => <TimelineEntryView entry={inner} app={app} />}
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
      <MarkdownBody content={entry.message.activity.text} app={app} />
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
        <MarkdownBody content={entry.message.content} app={app} />
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

/** The active session's route: transcript, composer, and session side pane. */
export const SessionPage: Component<SessionPageProps> = (props) => {
  const { app } = props;
  const session = props.session;
  const [patchPanelWidth, setPatchPanelWidth] = createSignal(520);
  let followupPicker: HTMLDivElement | undefined;

  const closeMenusOnPointerDown = (event: PointerEvent): void => {
    if (
      event.target instanceof Node &&
      !followupPicker?.contains(event.target) &&
      app.followupMenuOpen()
    ) {
      app.setFollowupMenuOpen(false);
    }
  };
  const closeMenusOnKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") app.setFollowupMenuOpen(false);
  };
  document.addEventListener("pointerdown", closeMenusOnPointerDown);
  document.addEventListener("keydown", closeMenusOnKeyDown);
  onCleanup(() => {
    document.removeEventListener("pointerdown", closeMenusOnPointerDown);
    document.removeEventListener("keydown", closeMenusOnKeyDown);
  });

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

  return (
    <section
      class="conversation"
      classList={{
        "side-open": !app.sideCollapsed(),
        "side-collapsed": app.sideCollapsed(),
      }}
      style={`--patch-panel-width: ${patchPanelWidth()}px`}
    >
      <header class="conversation-head">
        <div class="conversation-title">
          <strong>{session().title}</strong>
          <span>
            {describeModel(app.providers(), session())} · {session().folder}
          </span>
        </div>
      </header>
      <div
        class="transcript"
        ref={app.setTranscriptElement}
        onScroll={() => {
          const element = app.transcriptElement();
          if (element) app.transcriptScroll.observeScroll(element);
          if ((element?.scrollTop ?? 999) < 120) void app.loadOlder();
        }}
      >
        <div class="messages">
          <Show when={app.loadingOlder()}>
            <div class="loading-older">Loading earlier messages…</div>
          </Show>
          <Show when={app.loadingFeed()}>
            <div class="loading-older">Loading session…</div>
          </Show>
          <For each={app.timeline()}>
            {(entry, index) => (
              <>
                <TimelineEntryView entry={entry} app={app} />
                <Show
                  when={
                    app.activePlan() &&
                    session().status !== "running" &&
                    index() === app.planAfterIndex()
                  }
                >
                  <PlanPanel
                    plan={app.activePlan()!}
                    disabled={
                      app.submitting() || session().status === "running"
                    }
                    onImplementNext={(taskIndex, task) =>
                      void app.implementNext(taskIndex, task)
                    }
                  />
                </Show>
              </>
            )}
          </For>
          <Show when={app.error()}>
            {(value) => <div class="inline-error">{value()}</div>}
          </Show>
        </div>
      </div>
      <div class="composer-shell">
        <div class="composer">
          <textarea
            aria-label="Message the agent"
            value={app.prompt()}
            onInput={(event) => app.setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void app.sendMessage("implement");
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
            <Show when={app.activeSessionModel()?.model.reasoningEfforts}>
              {(efforts) => (
                <div class="model-picker" ref={followupPicker}>
                  <button
                    class="model-picker-trigger"
                    type="button"
                    aria-label="Adjust reasoning for this session"
                    aria-haspopup="dialog"
                    aria-expanded={app.followupMenuOpen()}
                    disabled={session().status === "running"}
                    onClick={() => app.setFollowupMenuOpen((open) => !open)}
                  >
                    <span>
                      {app.activeSessionModel()?.model.label ??
                        session().modelId}
                    </span>
                    <Show
                      when={
                        app.followupMode() === "incremental"
                          ? "incremental"
                          : app.followupEffort()
                      }
                    >
                      {(label) => <small>· {label()}</small>}
                    </Show>
                    <i aria-hidden="true">▾</i>
                  </button>
                  <Show when={app.followupMenuOpen()}>
                    <div
                      class="model-menu"
                      role="dialog"
                      aria-label="Reasoning settings"
                    >
                      <div class="model-menu-title">
                        {app.activeSessionModel()?.provider.label} ·{" "}
                        {app.activeSessionModel()?.model.label}
                      </div>
                      <div class="reasoning-picker">
                        <span>Reasoning</span>
                        <div class="reasoning-options">
                          <Show
                            when={supportsIncremental(session().providerId)}
                          >
                            <button
                              type="button"
                              class="incremental-option"
                              classList={{
                                selected: app.followupMode() === "incremental",
                              }}
                              title="Work in small, reviewable iterations with low reasoning. Saved when you send."
                              onClick={() => {
                                app.setMode(true, "incremental");
                                app.setFollowupEffort("low");
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
                                    app.followupMode() === "incremental"
                                      ? false
                                      : app.followupEffort() === effort,
                                }}
                                onClick={() => {
                                  app.setFollowupEffort(effort);
                                  if (app.followupMode() === "incremental")
                                    app.setMode(true, "standard");
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
            <Show when={app.latestUsage()}>
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
              <Show
                when={session().status === "running"}
                fallback={
                  <>
                    <button
                      class="send investigate"
                      type="button"
                      title="Read-only run: no file changes unless a reversible test is needed"
                      onClick={() => void app.sendMessage("investigate")}
                      disabled={
                        app.submitting() ||
                        session().status === "running" ||
                        !app.prompt().trim()
                      }
                    >
                      Investigate
                    </button>
                    <button
                      class="send"
                      type="button"
                      onClick={() => void app.sendMessage("implement")}
                      disabled={
                        app.submitting() ||
                        session().status === "running" ||
                        !app.prompt().trim()
                      }
                    >
                      Implement
                    </button>
                  </>
                }
              >
                <button
                  class="send secondary"
                  type="button"
                  title="Stop the agent"
                  onClick={() =>
                    void props.client.execute({
                      type: "cancel",
                      sessionId: session().id,
                    })
                  }
                >
                  Stop
                </button>
                <button
                  class="send secondary"
                  type="button"
                  title="Stop the agent and reply with a summary of where things stand"
                  onClick={() =>
                    void props.client.execute({
                      type: "interrupt",
                      sessionId: session().id,
                    })
                  }
                >
                  Interrupt
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>
      <aside
        class="side-pane"
        classList={{ collapsed: app.sideCollapsed() }}
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
        <div class="side-tabs" role="tablist" aria-label="Side panels">
          <For each={app.sideTabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="side-tab"
                classList={{ active: app.sideActive()?.id === tab.id }}
                aria-selected={app.sideActive()?.id === tab.id}
                aria-controls="agent-side-pane-content"
                title={sideTabLabel(tab, app.browserState())}
                onClick={() => {
                  app.focusSideTab(tab.id);
                  app.setSideCollapsed(false);
                }}
              >
                <span class="side-tab-icon" aria-hidden="true">
                  {sideTabDescriptors[tab.kind].icon}
                </span>
                <span class="side-tab-label">
                  {sideTabLabel(tab, app.browserState())}
                </span>
                <Show when={tab.kind === "patches"}>
                  <span class="side-tab-badge">{app.patches().length}</span>
                </Show>
                <Show when={!isPinnedSideTab(tab)}>
                  <span
                    class="side-tab-close"
                    role="button"
                    tabindex="0"
                    aria-label={`Close ${sideTabLabel(tab, app.browserState())}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      app.closeSideTab(tab);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        app.closeSideTab(tab);
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
            onClick={() => app.openBrowserSideTab()}
          >
            +
          </button>
          <button
            type="button"
            class="side-collapse"
            aria-label={
              app.sideCollapsed() ? "Expand side pane" : "Collapse side pane"
            }
            aria-expanded={!app.sideCollapsed()}
            onClick={() => app.setSideCollapsed((collapsed) => !collapsed)}
          >
            {app.sideCollapsed() ? "«" : "»"}
          </button>
        </div>
        <div class="side-pane-body" id="agent-side-pane-content">
          <Show when={app.sideActive()?.kind === "patches"}>
            <div
              class="patch-list"
              ref={app.setPatchListElement}
              onScroll={() => {
                const element = app.patchListElement();
                if (element) app.patchScroll.observeScroll(element);
              }}
            >
              <Show
                when={app.patches().length > 0}
                fallback={
                  <div class="patch-empty">
                    File changes will appear here as the agent works.
                  </div>
                }
              >
                <For each={app.patches()}>
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
                              ? message.activity.changes.map(({ path }) => path)
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
          <Show when={app.activeBrowserTab()} keyed>
            {(tab) => (
              <BrowserTabContent
                root={props.root}
                state={app.browserState()}
                tabId={tab.tabId}
                error={app.browserError()}
                onCommand={(command) => void app.runBrowser(command)}
                BrowserView={props.BrowserView}
              />
            )}
          </Show>
        </div>
      </aside>
    </section>
  );
};
