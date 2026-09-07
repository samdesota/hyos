import { Show, type Component } from "solid-js";

import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import type { AgentClient } from "./client.js";
import { agentStyles } from "./styles.js";
import { createAppState } from "./app-state.js";
import { GlobalTabPage } from "./GlobalTabPage.js";
import { NewSessionPage } from "./NewSessionPage.js";
import { SessionPage } from "./SessionPage.js";
import { Sidebar } from "./Sidebar.js";

type AgentAppProps = Readonly<{
  root: Document;
  client: AgentClient;
  browserClient: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

export const AgentApp: Component<AgentAppProps> = (props) => {
  console.log("[DEBUG-boot-7f2c] agent-renderer component:construct");
  const app = createAppState({
    client: props.client,
    browserClient: props.browserClient,
  });
  const { activeSession, focusedGlobalTab } = app;

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
