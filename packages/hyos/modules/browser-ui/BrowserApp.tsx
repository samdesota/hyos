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
  TabId,
} from "../../capabilities/browser.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { BrowserTabs } from "./BrowserTabs.js";
import { BrowserToolbar } from "./BrowserToolbar.js";
import { browserUiStyles } from "./styles.js";

export type ModuleControls = Readonly<{ reload(): Promise<void> }>;

type BrowserAppProps = Readonly<{
  root: Document;
  client: BrowserClient;
  BrowserView: BrowserViewModule["BrowserView"];
  modules: ModuleControls;
}>;

const emptyState: BrowserState = {
  generation: 0,
  sequence: 0,
  activeTabId: null,
  tabs: [],
};

export const BrowserApp: Component<BrowserAppProps> = (props) => {
  const [browserState, setBrowserState] = createSignal(emptyState);
  const [address, setAddress] = createSignal("https://example.com/");
  const [status, setStatus] = createSignal("Starting browser…");
  const activeTab = createMemo(() => {
    const state = browserState();
    return state.tabs.find(({ id }) => id === state.activeTabId);
  });

  const acceptState = (state: BrowserState): void => {
    setBrowserState(state);
    const tab = state.tabs.find(({ id }) => id === state.activeTabId);
    if (tab && props.root.activeElement?.id !== "address") setAddress(tab.url);
    if (!tab) return;
    setStatus(
      tab.error
        ? `Load failed: ${tab.error}`
        : `${tab.loading ? "Loading" : "Ready"} · ${state.tabs.length} tab${state.tabs.length === 1 ? "" : "s"} · generation ${state.generation}`,
    );
    props.root.title = tab.title
      ? `${tab.title} — HyOS`
      : "HyOS Browser Prototype";
  };
  const unsubscribe = props.client.subscribe(acceptState);
  onCleanup(unsubscribe);
  void props.client.execute({ type: "snapshot" }).then(acceptState);

  const run = async (command: BrowserCommand): Promise<void> => {
    setStatus("Sending command…");
    try {
      acceptState(await props.client.execute(command));
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const activate = (tabId: TabId): void => {
    void run({ type: "activate-tab", tabId });
  };

  return (
    <>
      <style>{browserUiStyles}</style>
      <div class="browser-app">
        <header class="browser-chrome">
          <div class="topline">
            <div class="traffic" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <strong>HyOS Browser</strong>
            <BrowserTabs
              state={browserState()}
              activate={activate}
              close={(tabId) => void run({ type: "close-tab", tabId })}
              create={() => void run({ type: "create-tab" })}
            />
            <button type="button" onClick={() => void props.modules.reload()}>
              Reload modules
            </button>
            <span class="protocol">
              {props.client.protocol.name} protocol v
              {props.client.protocol.version}
            </span>
          </div>
          <BrowserToolbar
            tab={activeTab()}
            address={address()}
            setAddress={setAddress}
            navigate={() => void run({ type: "navigate", url: address() })}
            back={() => void run({ type: "back" })}
            forward={() => void run({ type: "forward" })}
            reload={() => void run({ type: "reload" })}
          />
        </header>

        <main class="browser-stage">
          <Show when={browserState().activeTabId} keyed>
            {(tabId) => (
              <props.BrowserView tabId={tabId} class="active-browser-view" />
            )}
          </Show>
          <div class="renderer-overlay" data-browser-overlay>
            Solid renderer overlay
          </div>
        </main>

        <footer class="diagnostics">
          <span>{status()}</span>
          <details>
            <summary>module state</summary>
            <div>
              <b>Main</b> <code id="main-state">waiting…</code>
            </div>
            <div>
              <b>Renderer</b> <code id="renderer-state">waiting…</code>
            </div>
          </details>
        </footer>
      </div>
    </>
  );
};
