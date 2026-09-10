import { Show, Match, Switch, type Component } from "solid-js";

import type { BrowserViewModule } from "../browser-view/types.js";
import { BrowserTabContent } from "./browser-tab.js";
import type { AppState } from "./app-state.js";
import { WhiteboardPage } from "./WhiteboardPage.js";

export type GlobalTabPageProps = Readonly<{
  app: AppState;
  root: Document;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

/** The focused global tab's page: dispatched by tab kind. */
export const GlobalTabPage: Component<GlobalTabPageProps> = (props) => {
  const { app } = props;
  return (
    <Show when={app.focusedGlobalTab()} keyed>
      {(tab) => (
        <Switch>
          <Match when={tab.kind === "whiteboard" ? tab : undefined} keyed>
            {(whiteboard) => <WhiteboardPage boardId={whiteboard.boardId} />}
          </Match>
          <Match when={tab.kind === "browser" ? tab : undefined} keyed>
            {(browser) => (
              <section class="global-browser" aria-label="Global browser tab">
                <BrowserTabContent
                  root={props.root}
                  state={app.browserState()}
                  tabId={browser.tabId}
                  error={app.browserError()}
                  onCommand={(command) => void app.runBrowser(command)}
                  BrowserView={props.BrowserView}
                />
              </section>
            )}
          </Match>
        </Switch>
      )}
    </Show>
  );
};
