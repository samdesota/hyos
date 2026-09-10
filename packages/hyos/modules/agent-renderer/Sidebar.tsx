import { For, Show, createSignal, type Component, type JSX } from "solid-js";

import type { AgentSessionSummary } from "../../capabilities/agent.js";
import type { AppState } from "./app-state.js";
import { globalTabLabel } from "./global-tabs.js";
import { Modal } from "./Modal.js";
import { groupSessionsByFolder } from "./sessions-model.js";

const SessionFolderList: Component<{
  sessions: readonly AgentSessionSummary[];
  children: (session: AgentSessionSummary) => JSX.Element;
}> = (props) => {
  const groups = () => groupSessionsByFolder(props.sessions);
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
    closeGlobalTab,
    selectSession,
    newSession,
    setSessionArchived,
  } = props.app;
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createQuery, setCreateQuery] = createSignal("");
  const [createIndex, setCreateIndex] = createSignal(0);

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
      hint: "Coming soon",
      icon: "▦",
      run: () => {},
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
    setCreateQuery("");
    setCreateIndex(0);
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
            autofocus
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
                  title={
                    item.id === "whiteboard"
                      ? "Whiteboard (coming soon)"
                      : undefined
                  }
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
        </div>
      </Show>
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
                    onClick={() => void setSessionArchived(session.id, false)}
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
  );
};
