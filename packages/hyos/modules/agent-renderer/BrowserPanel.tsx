import {
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";

import type {
  BrowserCommand,
  BrowserState,
  BrowserTabState,
} from "../../capabilities/browser.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";

export type BrowserPanelProps = Readonly<{
  root: Document;
  client: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
  onClose(): void;
}>;

export const emptyBrowserState: BrowserState = {
  generation: 0,
  sequence: 0,
  activeTabId: null,
  tabs: [],
};

/** The tab the panel presents, or null when the browser has no active tab. */
export function activeTabOf(state: BrowserState): BrowserTabState | null {
  return state.tabs.find(({ id }) => id === state.activeTabId) ?? null;
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
 * Right-hand session panel hosting the native browser view. The panel owns
 * no tab state of its own: it mirrors the browser host's published state,
 * presents the active tab through `BrowserView`, and releases the
 * presentation automatically when it unmounts.
 */
export const BrowserPanel: Component<BrowserPanelProps> = (props) => {
  const [state, setState] = createSignal(emptyBrowserState);
  const [address, setAddress] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const tab = createMemo(() => activeTabOf(state()));
  const problem = createMemo(() => error() ?? tab()?.error ?? null);
  let input: HTMLInputElement | undefined;

  const acceptState = (next: BrowserState): void => {
    setState(next);
    const active = activeTabOf(next);
    setAddress((current) =>
      toolbarAddress(current, active, props.root.activeElement === input),
    );
  };

  const unsubscribe = props.client.subscribe(acceptState);
  onCleanup(unsubscribe);
  void props.client.execute({ type: "snapshot" }).then(acceptState);

  const run = async (command: BrowserCommand): Promise<void> => {
    setError(null);
    try {
      acceptState(await props.client.execute(command));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const submitAddress = (): void => {
    const url = address().trim();
    if (!url) return;
    input?.blur();
    void run({ type: "navigate", url });
  };

  return (
    <aside class="browser-panel" id="agent-browser-panel" aria-label="Browser">
      <div class="browser-panel-toolbar" data-browser-overlay>
        <button
          type="button"
          class="browser-nav"
          aria-label="Go back"
          disabled={!tab()?.canGoBack}
          onClick={() => void run({ type: "back" })}
        >
          ←
        </button>
        <button
          type="button"
          class="browser-nav"
          aria-label="Go forward"
          disabled={!tab()?.canGoForward}
          onClick={() => void run({ type: "forward" })}
        >
          →
        </button>
        <button
          type="button"
          class="browser-nav"
          aria-label="Reload page"
          disabled={!tab()}
          onClick={() => void run({ type: "reload" })}
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
        <button
          type="button"
          class="browser-panel-close"
          aria-label="Close browser panel"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div class="browser-panel-stage">
        <Show when={tab()} keyed>
          {(active) => (
            <props.BrowserView tabId={active.id} class="browser-panel-view" />
          )}
        </Show>
        <Show when={!tab()}>
          <div class="browser-panel-empty">
            <p>No browser tab is open.</p>
            <button
              type="button"
              onClick={() => void run({ type: "create-tab" })}
            >
              Open a page
            </button>
          </div>
        </Show>
      </div>
      <Show when={problem()}>
        {(message) => <div class="browser-panel-error">{message()}</div>}
      </Show>
    </aside>
  );
};
