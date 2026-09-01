import type { BrowserWindow } from "electron";
import {
  browserCapability,
  type BrowserCommand,
  type BrowserState,
  type TabId,
} from "../../capabilities/browser.js";
import type {
  MainRemoteCapabilities,
  RemoteProvider,
} from "../../remote-capabilities.js";
import { BrowserInputArbiter } from "./input-arbiter.js";
import { BrowserPresentations } from "./presentations.js";
import { createTabView, disposeTabView, tabState } from "./tab.js";
import type { BrowserMainConfig, Tab } from "./types.js";
import { normalizeUrl } from "./url.js";

export type BrowserHost = Readonly<{
  provider: RemoteProvider<typeof browserCapability>;
  start(): void;
  dispose(): void;
}>;

export function createBrowserHost(
  baseWindow: BrowserWindow,
  overlayWindow: BrowserWindow,
  remote: MainRemoteCapabilities,
  config: BrowserMainConfig,
): BrowserHost {
  const tabs = new Map<TabId, Tab>();
  const presentations = new BrowserPresentations(baseWindow, tabs);
  const input = new BrowserInputArbiter(overlayWindow, () =>
    presentations.visibleBounds(),
  );
  const generation = Date.now();
  let activeTabId: TabId | null = null;
  let nextTabId = 1;
  let sequence = 0;
  let accepting = true;

  const state = (): BrowserState => ({
    generation,
    sequence,
    activeTabId,
    tabs: [...tabs.values()].map(tabState),
  });
  const publish = (): void => {
    if (overlayWindow.isDestroyed()) return;
    sequence += 1;
    remote.publish(browserCapability, "state", state());
  };
  const activateTab = (tabId: TabId): void => {
    if (!tabs.has(tabId) || activeTabId === tabId) return;
    activeTabId = tabId;
    publish();
  };
  const createTab = (requestedUrl = config.initialUrl): Tab => {
    const id = `tab-${nextTabId++}` as TabId;
    const tab = createTabView({
      id,
      url: requestedUrl,
      publish,
      openTab: (url) => void createTab(url),
    });
    tabs.set(id, tab);
    activateTab(id);
    return tab;
  };
  const disposeTab = (tab: Tab): void => {
    presentations.removeTab(tab);
    tabs.delete(tab.id);
    disposeTabView(tab);
    if (activeTabId === tab.id) activeTabId = null;
    input.sync();
  };
  const closeTab = (tabId: TabId): void => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const orderedIds = [...tabs.keys()];
    const index = orderedIds.indexOf(tabId);
    const fallbackId = orderedIds[index + 1] ?? orderedIds[index - 1];
    disposeTab(tab);
    if (fallbackId) activateTab(fallbackId);
    else createTab();
    publish();
  };
  const execute = async (command: BrowserCommand): Promise<BrowserState> => {
    if (!accepting) throw new Error("Browser host is unloading");
    if (command.type === "create-tab") createTab(command.url);
    else if (command.type === "activate-tab") activateTab(command.tabId);
    else if (command.type === "close-tab") closeTab(command.tabId);
    else if (command.type !== "snapshot") {
      const tab = activeTabId ? tabs.get(activeTabId) : undefined;
      if (!tab) throw new Error("No active browser tab");
      tab.error = null;
      if (command.type === "navigate") {
        await tab.contents.loadURL(normalizeUrl(command.url));
      } else if (
        command.type === "back" &&
        tab.contents.navigationHistory.canGoBack()
      ) {
        tab.contents.navigationHistory.goBack();
      } else if (
        command.type === "forward" &&
        tab.contents.navigationHistory.canGoForward()
      ) {
        tab.contents.navigationHistory.goForward();
      } else if (command.type === "reload") tab.contents.reload();
    }
    publish();
    return state();
  };

  const provider: RemoteProvider<typeof browserCapability> = {
    execute,
    present(presentation) {
      presentations.present(presentation);
      input.sync();
    },
    release(presentationId) {
      presentations.release(presentationId);
      input.sync();
    },
    setOverlayRegions(regions) {
      input.setOverlayRegions(regions);
    },
  };

  return {
    provider,
    start() {
      createTab();
    },
    dispose() {
      accepting = false;
      input.dispose();
      for (const tab of [...tabs.values()]) disposeTab(tab);
    },
  };
}
