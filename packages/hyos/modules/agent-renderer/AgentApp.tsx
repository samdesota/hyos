import { For, Show, type Component, type JSX } from "solid-js";

import type { AgentSessionSummary } from "../../capabilities/agent.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import type { AgentClient } from "./client.js";
import { globalTabLabel } from "./global-tabs.js";
import { agentStyles } from "./styles.js";
import { createAppState } from "./app-state.js";
import { GlobalTabPage } from "./GlobalTabPage.js";
import { NewSessionPage } from "./NewSessionPage.js";
import { SessionPage } from "./SessionPage.js";
import { groupSessionsByFolder } from "./sessions-model.js";

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
  browserClient: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

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

export const AgentApp: Component<AgentAppProps> = (props) => {
  console.log("[DEBUG-boot-7f2c] agent-renderer component:construct");
  const app = createAppState({
    client: props.client,
    browserClient: props.browserClient,
  });
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
  } = app;

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
          <GlobalTabPage
            app={app}
            root={props.root}
            BrowserView={props.BrowserView}
          />
          <Show
            when={!focusedGlobalTab() && activeSession()}
            fallback={<NewSessionPage app={app} />}
          >
            {(session) => (
              <SessionPage
                app={app}
                client={props.client}
                session={session}
                root={props.root}
                BrowserView={props.BrowserView}
              />
            )}
          </Show>
        </main>
      </div>
    </>
  );
};
