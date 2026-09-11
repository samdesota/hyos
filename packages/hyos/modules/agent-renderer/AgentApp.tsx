import { useLocation, useMatch, useNavigate } from "@solidjs/router";
import { createEffect, Show, type Component } from "solid-js";

import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import type { WhiteboardViewModule } from "../whiteboard/renderer/types.js";
import type { AgentClient, KeybindingClient } from "./client.js";
import { agentStyles } from "./styles.js";
import { createAppState } from "./app-state.js";
import { GlobalTabPage } from "./GlobalTabPage.js";
import { NewSessionPage } from "./NewSessionPage.js";
import { SessionPage } from "./SessionPage.js";
import { Sidebar } from "./Sidebar.js";
import { routeFromParams, ROUTE_PATHS } from "./session-route.js";

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
  keybindingClient: KeybindingClient;
  browserClient: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
  WhiteboardPage: WhiteboardViewModule["WhiteboardPage"];
}>;

export const AgentApp: Component<AgentAppProps> = (props) => {
  console.log("[DEBUG-boot-7f2c] agent-renderer component:construct");
  const navigate = useNavigate();
  const location = useLocation();
  let app!: ReturnType<typeof createAppState>;
  app = createAppState({
    client: props.client,
    keybindingClient: props.keybindingClient,
    browserClient: props.browserClient,
    navigateToSession: (sessionId) => {
      const next = sessionId
        ? `/session/${encodeURIComponent(sessionId)}`
        : "/";
      // Navigating to the current path would push a redundant history
      // entry, and re-selecting the active session must stay a no-op.
      if (location.pathname === next) return;
      navigate(next, { replace: true });
    },
    navigateToGlobalTab: (tabId) => {
      // Dropping tab focus falls back to the still-open session, else the
      // new-session view — mirroring what the strip's fallback showed.
      const next = tabId
        ? `/tabs/${encodeURIComponent(tabId)}`
        : app.activeId()
          ? `/session/${encodeURIComponent(app.activeId()!)}`
          : "/";
      if (location.pathname === next) return;
      navigate(next, { replace: true });
    },
  });
  const { activeSession, focusedGlobalTab } = app;

  // The URL is authoritative: derive the open view from the route. A
  // `/session/:id` route selects that session (once sessions have loaded),
  // and `/` returns to the new-session view. Other routes (global tabs,
  // unrecognized hashes) leave the underlying session untouched.
  const sessionMatch = useMatch(() => ROUTE_PATHS.session);
  createEffect(() => {
    const route = routeFromParams("session", sessionMatch()?.params.id);
    if (route.kind === "session") {
      const routedId = route.sessionId;
      if (
        app.activeId() !== routedId &&
        app.sessions().some(({ id }) => id === routedId)
      )
        void app.selectSession(routedId);
      return;
    }
    if (location.pathname === "/" && app.activeId() !== null) app.newSession();
  });

  // Global tab focus follows the same rule: `/tabs/:id` focuses that tab,
  // and any other route holds no tab focus. Only a tab present in the strip
  // can be focused — a stale or unknown id (a reload, a just-closed tab)
  // focuses nothing rather than inventing a selection.
  const tabsMatch = useMatch(() => ROUTE_PATHS.globalTabs);
  createEffect(() => {
    const route = routeFromParams("global-tabs", tabsMatch()?.params.id);
    if (route.kind === "global-tabs") {
      const tabId = route.tabId;
      if (
        app.activeGlobalTabId() !== tabId &&
        app.globalTabs().some(({ id }) => id === tabId)
      )
        app.setActiveGlobalTabId(tabId);
      return;
    }
    if (app.activeGlobalTabId() !== null) app.setActiveGlobalTabId(null);
  });

  return (
    <>
      <style>{agentStyles}</style>
      <div class="agent-app" id="agent-app">
        <code id="main-state" hidden />
        <code id="renderer-state" hidden />
        <div class="window-drag-region" aria-hidden="true" />
        <Sidebar app={app} />

        <main class="agent-main">
          <GlobalTabPage
            app={app}
            root={props.root}
            BrowserView={props.BrowserView}
            WhiteboardPage={props.WhiteboardPage}
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
