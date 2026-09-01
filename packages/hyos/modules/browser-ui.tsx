import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { render } from "solid-js/web";
import type {
  BrowserCommand,
  BrowserState,
  TabId,
} from "../capabilities/browser.js";
import type { BrowserClient } from "./browser-client.js";
import type { BrowserViewModule } from "./browser-view.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

type ModuleControls = Readonly<{ reload(): Promise<void> }>;

const emptyState: BrowserState = {
  generation: 0,
  sequence: 0,
  activeTabId: null,
  tabs: [],
};

registerModule(
  defineModule({
    id: "browser.renderer",
    inject: [
      "dom.root",
      "browser.client",
      "browser.view",
      "application.modules",
    ],
    provide: ["browser.ui"],

    apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const client = ctx.get<BrowserClient>("browser.client");
      const { BrowserView } = ctx.get<BrowserViewModule>("browser.view");
      const modules = ctx.get<ModuleControls>("application.modules");
      const mount = root.querySelector<HTMLElement>("#app");
      if (!mount) throw new Error("Missing Solid application mount");

      const App: Component = () => {
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
          if (tab && root.activeElement?.id !== "address") setAddress(tab.url);
          if (tab) {
            setStatus(
              tab.error
                ? `Load failed: ${tab.error}`
                : `${tab.loading ? "Loading" : "Ready"} · ${state.tabs.length} tab${state.tabs.length === 1 ? "" : "s"} · generation ${state.generation}`,
            );
            root.title = tab.title
              ? `${tab.title} — HyOS`
              : "HyOS Browser Prototype";
          }
        };
        const unsubscribe = client.subscribe(acceptState);
        onCleanup(unsubscribe);
        void client.execute({ type: "snapshot" }).then(acceptState);

        const run = async (command: BrowserCommand): Promise<void> => {
          setStatus("Sending command…");
          try {
            acceptState(await client.execute(command));
          } catch (error: unknown) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        };
        const activate = (tabId: TabId): void => {
          void run({ type: "activate-tab", tabId });
        };

        return (
          <>
            <style>{styles}</style>
            <div class="browser-app">
              <header class="browser-chrome">
                <div class="topline">
                  <div class="traffic" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <strong>HyOS Browser</strong>
                  <div class="browser-tabs-shell">
                    <div class="browser-tabs">
                      <For each={browserState().tabs}>
                        {(tab) => (
                          <div
                            class="browser-tab"
                            classList={{
                              active: tab.id === browserState().activeTabId,
                            }}
                          >
                            <button
                              class="browser-tab-select"
                              type="button"
                              title={tab.title || tab.url || "New tab"}
                              onClick={() => activate(tab.id)}
                            >
                              {tab.title || tab.url || "New tab"}
                            </button>
                            <button
                              class="browser-tab-close"
                              type="button"
                              title="Close tab"
                              onClick={() =>
                                void run({ type: "close-tab", tabId: tab.id })
                              }
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
                      onClick={() => void run({ type: "create-tab" })}
                    >
                      +
                    </button>
                  </div>
                  <button type="button" onClick={() => void modules.reload()}>
                    Reload modules
                  </button>
                  <span class="protocol">
                    {client.protocol.name} protocol v{client.protocol.version}
                  </span>
                </div>
                <form
                  class="toolbar"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run({ type: "navigate", url: address() });
                  }}
                >
                  <button
                    type="button"
                    aria-label="Back"
                    disabled={!activeTab()?.canGoBack}
                    onClick={() => void run({ type: "back" })}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    aria-label="Forward"
                    disabled={!activeTab()?.canGoForward}
                    onClick={() => void run({ type: "forward" })}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    aria-label="Reload"
                    onClick={() => void run({ type: "reload" })}
                  >
                    {activeTab()?.loading ? "×" : "↻"}
                  </button>
                  <input
                    id="address"
                    aria-label="Address"
                    value={address()}
                    onInput={(event) => setAddress(event.currentTarget.value)}
                  />
                  <button class="go" type="submit">
                    Go
                  </button>
                </form>
              </header>

              <main class="browser-stage">
                <Show when={browserState().activeTabId} keyed>
                  {(tabId) => (
                    <BrowserView tabId={tabId} class="active-browser-view" />
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

      const dispose = render(() => <App />, mount);
      ctx.provide("browser.ui", { BrowserView });
      ctx.effect(() => dispose);
    },
  }),
);

const styles = `
  :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color:#292620; }
  * { box-sizing:border-box; }
  html, body, #app { width:100%; height:100%; margin:0; overflow:hidden; background:transparent; }
  button, input { font:inherit; }
  button { border:1px solid #cec7bb; background:#fff; border-radius:7px; color:#4c453c; cursor:pointer; }
  button:disabled { opacity:.38; cursor:default; }
  .browser-app { width:100%; height:100%; display:grid; grid-template-rows:auto minmax(0, 1fr) auto; background:transparent; }
  .browser-chrome { padding:12px 16px 10px; background:rgba(248,246,241,.98); border-bottom:1px solid #c8c1b6; box-shadow:0 2px 10px rgb(56 47 34 / 10%); }
  .topline { height:28px; display:flex; align-items:center; gap:12px; min-width:0; }
  .topline strong { white-space:nowrap; }
  .traffic { display:flex; gap:7px; }
  .traffic i { width:10px; height:10px; border-radius:50%; background:#dd6857; }
  .traffic i:nth-child(2) { background:#dda743; }
  .traffic i:nth-child(3) { background:#70ae78; }
  .browser-tabs-shell { display:flex; align-items:center; gap:4px; flex:1; min-width:100px; overflow:hidden; }
  .browser-tabs { display:flex; gap:3px; min-width:0; overflow-x:auto; scrollbar-width:none; }
  .browser-tab { display:flex; align-items:center; height:24px; min-width:105px; max-width:180px; border:1px solid #c7c0b5; border-radius:7px; background:#e7e1d8; overflow:hidden; }
  .browser-tab.active { background:#fff; border-color:#8b6d45; box-shadow:0 1px 3px rgb(43 38 30 / 12%); }
  .browser-tab-select { height:22px; min-width:0; flex:1; padding:0 4px 0 8px; border:0; background:transparent; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; font-size:11px; }
  .browser-tab-close { height:20px; min-width:22px; padding:0; border:0; background:transparent; font-size:14px; }
  .browser-new-tab { height:24px; min-width:26px; padding:0; font-size:16px; }
  .protocol { color:#6c645a; font-size:11px; white-space:nowrap; }
  .toolbar { display:flex; gap:8px; margin-top:9px; }
  .toolbar button { width:42px; height:34px; }
  .toolbar input { flex:1; min-width:80px; height:34px; padding:0 12px; border:1px solid #c8c1b6; border-radius:8px; background:white; font-size:16px; }
  .toolbar .go { width:54px; background:#80613d; border-color:#80613d; color:white; font-weight:700; }
  .browser-stage { position:relative; min-width:0; min-height:0; background:transparent; }
  .active-browser-view { position:absolute; inset:14px 18px 12px; background:transparent; }
  .renderer-overlay { position:absolute; top:28px; right:32px; z-index:5; padding:8px 11px; border:1px solid rgb(255 255 255 / 65%); border-radius:999px; background:rgb(32 31 28 / 82%); color:white; box-shadow:0 4px 16px rgb(0 0 0 / 20%); font-size:11px; pointer-events:auto; }
  .diagnostics { display:flex; justify-content:space-between; align-items:center; min-height:42px; padding:8px 16px; background:rgba(248,246,241,.98); border-top:1px solid #c8c1b6; color:#625b51; font-size:12px; }
  .diagnostics details { text-align:right; }
  .diagnostics code { display:inline-block; max-width:580px; overflow:hidden; text-overflow:ellipsis; vertical-align:bottom; white-space:nowrap; }
`;
