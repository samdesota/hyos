import { For, type Component } from "solid-js";
import type { BrowserState, TabId } from "../../capabilities/browser.js";

type BrowserTabsProps = Readonly<{
  state: BrowserState;
  activate(tabId: TabId): void;
  close(tabId: TabId): void;
  create(): void;
}>;

export const BrowserTabs: Component<BrowserTabsProps> = (props) => (
  <div class="browser-tabs-shell">
    <div class="browser-tabs">
      <For each={props.state.tabs}>
        {(tab) => (
          <div
            class="browser-tab"
            classList={{ active: tab.id === props.state.activeTabId }}
          >
            <button
              class="browser-tab-select"
              type="button"
              title={tab.title || tab.url || "New tab"}
              onClick={() => props.activate(tab.id)}
            >
              {tab.title || tab.url || "New tab"}
            </button>
            <button
              class="browser-tab-close"
              type="button"
              title="Close tab"
              onClick={() => props.close(tab.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
    <button
      class="browser-new-tab"
      type="button"
      title="New tab"
      onClick={props.create}
    >
      +
    </button>
  </div>
);
