import { For, Show, createSignal, type Component, type JSX } from "solid-js";

import type { AgentSessionSummary } from "../../capabilities/agent.js";
import type { AppState } from "./app-state.js";
import { globalTabLabel } from "./global-tabs.js";
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

/** App sidebar: brand, new-session button, global tab strip, session list. */
export const Sidebar: Component<{ app: AppState }> = (props) => {
  const {
    activeId,
    activeSession,
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
  const [newMenuOpen, setNewMenuOpen] = createSignal(false);

  return (
    <aside class="agent-sidebar">
      <div class="sidebar-head">
        <div class="brand">
          <span class="brand-mark">H</span>
          <strong>hyos</strong>
        </div>
        <div
          class="new-session-wrap"
          classList={{ open: newMenuOpen() || !activeSession() }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setNewMenuOpen(false);
          }}
        >
          <button
            class="new-session"
            type="button"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen()}
            onClick={() => setNewMenuOpen(!newMenuOpen())}
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
              {/* lucide plus */}
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            New
            <svg
              class="new-session-chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              {/* lucide chevron-down */}
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <Show when={newMenuOpen()}>
            <div
              class="new-session-backdrop"
              onClick={() => setNewMenuOpen(false)}
            />
            <div class="new-session-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                class="new-session-item"
                onClick={() => {
                  setNewMenuOpen(false);
                  void openGlobalTab();
                }}
              >
                <span class="new-session-item-icon" aria-hidden="true">
                  ◉
                </span>
                <span class="new-session-item-text">
                  <strong>Web</strong>
                  <span class="new-session-item-hint">New browser tab</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="new-session-item"
                onClick={() => {
                  setNewMenuOpen(false);
                  newSession();
                }}
              >
                <span class="new-session-item-icon" aria-hidden="true">
                  ✎
                </span>
                <span class="new-session-item-text">
                  <strong>Session</strong>
                  <span class="new-session-item-hint">New agent session</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="new-session-item"
                title="Whiteboard (coming soon)"
                onClick={() => setNewMenuOpen(false)}
              >
                <span class="new-session-item-icon" aria-hidden="true">
                  ▦
                </span>
                <span class="new-session-item-text">
                  <strong>Whiteboard</strong>
                  <span class="new-session-item-hint">Coming soon</span>
                </span>
              </button>
            </div>
          </Show>
        </div>
      </div>
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
