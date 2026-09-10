import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";

import type { AgentSessionSummary } from "../../capabilities/agent.js";
import type { AppState } from "./app-state.js";
import { globalTabDescriptors, globalTabLabel } from "./global-tabs.js";
import { Modal } from "./Modal.js";
import { groupSessionsByFolder } from "./sessions-model.js";

const SessionFolderList: Component<{
  sessions: readonly AgentSessionSummary[];
  children: (session: () => AgentSessionSummary) => JSX.Element;
}> = (props) => {
  // Key-stable rendering: folder sections are keyed by folder string and
  // session rows by session id (plain strings, so <For> diffs by value), and
  // all content reads the current summary through reactive lookups. The host
  // republishes the whole list on every streamed chunk (sessions are ordered
  // by updatedAt), so keying rows by object reference would tear the sidebar
  // down mid-interaction — losing hover on the archive button and the
  // mousedown/mouseup pairing clicks need. Field changes patch in place.
  const byId = createMemo(
    () =>
      new Map(props.sessions.map((session) => [session.id, session] as const)),
  );
  const groups = createMemo(() => groupSessionsByFolder(props.sessions));
  return (
    <For each={groups().map(({ folder }) => folder)}>
      {(folder) => (
        <Show when={groups().find((group) => group.folder === folder)}>
          {(group) => (
            <section
              class="session-folder-group"
              aria-label={group().folder || group().label}
            >
              <h3
                class="session-folder-heading"
                title={group().folder || group().label}
              >
                <span class="session-folder-name">{group().label}</span>
                <Show when={group().parentPath}>
                  <span class="session-folder-parent">
                    {group().parentPath}
                  </span>
                </Show>
              </h3>
              <For each={group().sessions.map(({ id }) => id)}>
                {(id) => props.children(() => byId().get(id)!)}
              </For>
            </section>
          )}
        </Show>
      )}
    </For>
  );
};

/**
 * Inline-renameable session title: double-click swaps the label for an
 * identically sized input with the full text pre-selected. Enter or blur
 * commits through the host's rename-session command; Escape discards.
 */
const SessionTitle: Component<{
  session: AgentSessionSummary;
  onRename: (title: string) => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;

  const startEditing = (): void => {
    setDraft(props.session.title);
    setEditing(true);
    // Focus once the input exists; select() highlights the full title.
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  };
  const stopEditing = (): void => {
    setEditing(false);
  };
  const commit = (): void => {
    const title = draft().trim();
    stopEditing();
    if (title && title !== props.session.title) props.onRename(title);
  };

  return (
    <Show
      when={editing()}
      fallback={
        <span class="session-title" onDblClick={startEditing}>
          {props.session.title}
        </span>
      }
    >
      <input
        ref={input}
        class="session-title-input"
        type="text"
        aria-label="Session title"
        value={draft()}
        // Keep the wrapping button from re-selecting the session while
        // the user clicks or presses keys inside the input.
        onClick={(event) => {
          event.stopPropagation();
        }}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            stopEditing();
          }
        }}
      />
    </Show>
  );
};

/**
 * Session status line: nothing by default, a spinner plus the short work
 * description while the session runs, and the finished description tinted
 * by the run's outcome once it ends. It stays until the next turn starts.
 */
const SessionMeta: Component<{ session: AgentSessionSummary }> = (props) => (
  <span class="session-meta">
    <Show when={props.session.status === "running"}>
      <i class="session-spinner" aria-label="Running" />
    </Show>
    <Show when={props.session.statusDetail}>
      {(detail) => (
        <span class={`session-status-text ${props.session.status}`}>
          {detail()}
        </span>
      )}
    </Show>
  </span>
);

/** App sidebar: brand, global tab strip, session list. */
export const Sidebar: Component<{ app: AppState }> = (props) => {
  const {
    activeId,
    activeSessions,
    archivedOpen,
    setArchivedOpen,
    archivedSessions,
    browserState,
    globalTabs,
    setActiveGlobalTabId,
    focusedGlobalTab,
    openGlobalTab,
    openWhiteboardTab,
    closeGlobalTab,
    selectSession,
    newSession,
    setSessionArchived,
    renameSession,
    createOpen,
    setCreateOpen,
  } = props.app;
  const [createQuery, setCreateQuery] = createSignal("");
  const [createIndex, setCreateIndex] = createSignal(0);
  let createInput: HTMLInputElement | undefined;

  // Reset the search/selection each time the modal opens, whether via the
  // "+" button or the app-level Cmd/Ctrl+T accelerator.
  createEffect(() => {
    if (createOpen()) {
      setCreateQuery("");
      setCreateIndex(0);
      // Focus on the next frame, after the portal content is in the DOM —
      // covers both the "+" button and the CmdOrCtrl+T accelerator.
      queueMicrotask(() => createInput?.focus());
    }
  });

  const createItems: readonly {
    id: string;
    label: string;
    hint: string;
    icon: string;
    run: () => void;
  }[] = [
    {
      id: "session",
      label: "Session",
      hint: "New agent session",
      icon: "✎",
      run: () => newSession(),
    },
    {
      id: "web",
      label: "Web",
      hint: "New browser tab",
      icon: "◉",
      run: () => void openGlobalTab(),
    },
    {
      id: "whiteboard",
      label: "Whiteboard",
      hint: "New whiteboard",
      icon: "▦",
      run: () => openWhiteboardTab(crypto.randomUUID()),
    },
  ];
  const filteredCreateItems = () => {
    const query = createQuery().trim().toLowerCase();
    if (!query) return createItems;
    return createItems.filter((item) =>
      item.label.toLowerCase().includes(query),
    );
  };
  const openCreateModal = (): void => {
    setCreateOpen(true);
  };
  const runCreateItem = (item: (typeof createItems)[number]): void => {
    setCreateOpen(false);
    item.run();
  };

  return (
    <aside class="agent-sidebar">
      <div class="sidebar-head">
        <div class="brand">
          <span class="brand-mark">H</span>
          <strong>hyos</strong>
          <div class="brand-new-wrap">
            <button
              class="brand-new"
              type="button"
              aria-label="Create new"
              title="Create new"
              aria-haspopup="dialog"
              aria-expanded={createOpen()}
              onClick={openCreateModal}
            >
              <svg
                class="brand-new-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                {/* lucide plus */}
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <Modal
        open={createOpen()}
        onClose={() => setCreateOpen(false)}
        label="Create new"
      >
        <div
          onKeyDown={(e) => {
            const items = filteredCreateItems();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCreateIndex((i) =>
                items.length ? (i + 1) % items.length : 0,
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCreateIndex((i) =>
                items.length ? (i - 1 + items.length) % items.length : 0,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = items[createIndex()];
              if (item) runCreateItem(item);
            }
          }}
        >
          <input
            class="create-input"
            type="text"
            placeholder="Create new…"
            aria-label="Search what to create"
            ref={createInput}
            value={createQuery()}
            onInput={(e) => {
              setCreateQuery(e.currentTarget.value);
              setCreateIndex(0);
            }}
          />
          <div class="create-list" role="listbox">
            <For each={filteredCreateItems()}>
              {(item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index() === createIndex()}
                  class="create-item"
                  classList={{ selected: index() === createIndex() }}
                  onClick={() => runCreateItem(item)}
                  onMouseEnter={() => setCreateIndex(index())}
                >
                  <span class="create-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span class="create-item-text">
                    <strong>{item.label}</strong>
                    <span class="create-item-hint">{item.hint}</span>
                  </span>
                </button>
              )}
            </For>
            <Show when={filteredCreateItems().length === 0}>
              <div class="create-empty">No matches</div>
            </Show>
          </div>
        </div>
      </Modal>
      <Show when={globalTabs().length > 0}>
        <div class="global-tabs" aria-label="Global tabs">
          <div class="global-tabs-head">
            <span class="session-label global-tabs-label">Tabs</span>
          </div>
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
                      {globalTabDescriptors[tab.kind].icon}
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
        </div>
      </Show>
      <div class="session-label">Sessions</div>
      <div class="session-list" id="agent-session-list">
        <SessionFolderList sessions={activeSessions()}>
          {(session) => (
            <Show when={session()}>
              {(s) => (
                <div
                  class="session-row"
                  classList={{ active: activeId() === s().id }}
                >
                  <button
                    type="button"
                    class="session-open"
                    onClick={() => void selectSession(s().id)}
                  >
                    <SessionTitle
                      session={s()}
                      onRename={(title) => void renameSession(s().id, title)}
                    />
                    <SessionMeta session={s()} />
                  </button>
                  <button
                    type="button"
                    class="session-archive"
                    aria-label={`Archive "${s().title}"`}
                    title="Archive session"
                    onClick={() => void setSessionArchived(s().id, true)}
                  >
                    ×
                  </button>
                </div>
              )}
            </Show>
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
                <Show when={session()}>
                  {(s) => (
                    <div
                      class="session-row archived"
                      classList={{ active: activeId() === s().id }}
                    >
                      <button
                        type="button"
                        class="session-open"
                        onClick={() => void selectSession(s().id)}
                      >
                        <SessionTitle
                          session={s()}
                          onRename={(title) =>
                            void renameSession(s().id, title)
                          }
                        />
                        <SessionMeta session={s()} />
                      </button>
                      <button
                        type="button"
                        class="session-archive"
                        aria-label={`Unarchive "${s().title}"`}
                        title="Unarchive session"
                        onClick={() => void setSessionArchived(s().id, false)}
                      >
                        ↩
                      </button>
                    </div>
                  )}
                </Show>
              )}
            </SessionFolderList>
          </Show>
        </Show>
      </div>
    </aside>
  );
};
