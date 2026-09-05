import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";

import type {
  BrowserCommand,
  BrowserState,
  BrowserTabState,
  TabId,
} from "../../capabilities/browser.js";
import type { BrowserViewModule } from "../browser-view/types.js";

export type BrowserTabContentProps = Readonly<{
  root: Document;
  state: BrowserState;
  tabId: TabId | null;
  error: string | null;
  onCommand(command: BrowserCommand): void;
  BrowserView: BrowserViewModule["BrowserView"];
}>;

export const emptyBrowserState: BrowserState = {
  generation: 0,
  sequence: 0,
  activeTabId: null,
  tabs: [],
};

/** The host tab with the given id, or null when the host no longer knows it. */
export function tabOf(
  state: BrowserState,
  tabId: TabId | null,
): BrowserTabState | null {
  return tabId ? (state.tabs.find(({ id }) => id === tabId) ?? null) : null;
}

/**
 * Address the toolbar shows: the live tab URL, unless the user is editing
 * the field, in which case their in-progress draft is kept.
 */
export function toolbarAddress(
  current: string,
  tab: BrowserTabState | null,
  editing: boolean,
): string {
  return editing || !tab ? current : tab.url;
}

/**
 * Content of a browser side tab in the session side pane: the navigation
 * toolbar, the native view stage presenting this tab's host tab, and any
 * error line. It owns no tab state — the host's published state and the
 * focused side tab arrive as props, and mounting the view presents the tab
 * while unmounting releases the presentation.
 */
export const BrowserTabContent: Component<BrowserTabContentProps> = (props) => {
  const [address, setAddress] = createSignal("");
  const tab = createMemo(() => tabOf(props.state, props.tabId));
  const problem = createMemo(() => props.error ?? tab()?.error ?? null);
  let input: HTMLInputElement | undefined;

  createEffect(() => {
    setAddress((current) =>
      toolbarAddress(current, tab(), props.root.activeElement === input),
    );
  });

  const submitAddress = (): void => {
    const url = address().trim();
    if (!url) return;
    input?.blur();
    props.onCommand({ type: "navigate", url });
  };

  return (
    <div class="browser-tab">
      <div class="browser-panel-toolbar" data-browser-overlay>
        <button
          type="button"
          class="browser-nav"
          aria-label="Go back"
          disabled={!tab()?.canGoBack}
          onClick={() => props.onCommand({ type: "back" })}
        >
          ←
        </button>
        <button
          type="button"
          class="browser-nav"
          aria-label="Go forward"
          disabled={!tab()?.canGoForward}
          onClick={() => props.onCommand({ type: "forward" })}
        >
          →
        </button>
        <button
          type="button"
          class="browser-nav"
          aria-label="Reload page"
          disabled={!tab()}
          onClick={() => props.onCommand({ type: "reload" })}
        >
          ↻
        </button>
        <input
          ref={input}
          class="browser-address"
          type="text"
          value={address()}
          placeholder="Search or enter address"
          spellcheck={false}
          aria-label="Browser address"
          onInput={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitAddress();
            }
          }}
        />
      </div>
      <div class="browser-panel-stage">
        <Show when={tab()} keyed>
          {(active) => (
            <props.BrowserView tabId={active.id} class="browser-panel-view" />
          )}
        </Show>
        <Show when={!tab()}>
          <div class="browser-panel-empty">
            <p>This browser tab is no longer available.</p>
          </div>
        </Show>
      </div>
      <Show when={problem()}>
        {(message) => <div class="browser-panel-error">{message()}</div>}
      </Show>
    </div>
  );
};
