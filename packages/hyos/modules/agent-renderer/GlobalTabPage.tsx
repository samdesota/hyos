import { Show, type Component } from "solid-js";

import type { BrowserViewModule } from "../browser-view/types.js";
import { BrowserTabContent } from "./browser-tab.js";
import type { AppState } from "./app-state.js";

export type GlobalTabPageProps = Readonly<{
  app: AppState;
  root: Document;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

/** The focused global tab's page: a full-main-area browser view. */
export const GlobalTabPage: Component<GlobalTabPageProps> = (props) => {
  const { app } = props;
  return (
    <Show when={app.focusedGlobalTab()} keyed>
      {(tab) => (
        <section class="global-browser" aria-label="Global browser tab">
          <BrowserTabContent
            root={props.root}
            state={app.browserState()}
            tabId={tab.tabId}
            error={app.browserError()}
            onCommand={(command) => void app.runBrowser(command)}
            BrowserView={props.BrowserView}
          />
        </section>
      )}
    </Show>
  );
};
