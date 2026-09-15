import type { BrowserWindow, WebContentsView } from "electron";
import {
  browserCapability,
  type BrowserCommand,
  type BrowserState,
  type CdpEndpoint,
  type CdpTargetOpen,
  type TabId,
} from "../../capabilities/browser.js";
import type {
  MainRemoteCapabilities,
  RemoteProvider,
} from "../../remote-capabilities.js";
import { listCdpTargets, resolveCdpFrontendUrl } from "./cdp.js";
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
  uiView: WebContentsView,
  remote: MainRemoteCapabilities,
  config: BrowserMainConfig,
): BrowserHost {
  const tabs = new Map<TabId, Tab>();
  // Single-window layering: browser views are appended to the window's
  // contentView after the UI view, so they composite above it and receive
  // clicks within their presentation bounds; the UI receives input
  // everywhere else. No pass-through arbiter is needed.
  const presentations = new BrowserPresentations(baseWindow, uiView, tabs);
  const generation = Date.now();
  let activeTabId: TabId | null = null;
  let sequence = 0;
  let accepting = true;

  const state = (): BrowserState => ({
    generation,
    sequence,
    activeTabId,
    tabs: [...tabs.values()].map(tabState),
  });
  const publish = (): void => {
    if (uiView.webContents.isDestroyed()) return;
    sequence += 1;
    remote.publish(browserCapability, "state", state());
  };
  const activateTab = (tabId: TabId): void => {
    if (!tabs.has(tabId) || activeTabId === tabId) return;
    activeTabId = tabId;
    publish();
  };
  const createTab = (requestedUrl = config.initialUrl): Tab => {
    // Tab ids are UUIDs: unique across host reloads and restarts, so a
    // persisted {tabId} pair can be re-adopted without a recycled counter id
    // ever pointing at a different page.
    const id = crypto.randomUUID() as TabId;
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

  /**
   * Open a discovered CDP target's devtools frontend as an ordinary browser
   * tab. The tab is closable through the regular `close-tab` command, so no
   * separate close path is needed.
   */
  const openCdpTarget = async (
    endpoint: CdpEndpoint,
    targetId: string,
  ): Promise<CdpTargetOpen> => {
    const targets = await listCdpTargets(endpoint);
    const target = targets.find(({ id }) => id === targetId);
    if (!target) {
      throw new Error(
        `No CDP target ${targetId} on ${endpoint.host}:${endpoint.port}`,
      );
    }
    const tab = createTab(
      normalizeUrl(resolveCdpFrontendUrl(endpoint, target)),
    );
    publish();
    return { tabId: tab.id, target };
  };

  const provider: RemoteProvider<typeof browserCapability> = {
    execute,
    inspectCdp: (endpoint) => listCdpTargets(endpoint),
    openCdpTarget: ({ endpoint, targetId }) =>
      openCdpTarget(endpoint, targetId),
    present(presentation) {
      presentations.present(presentation);
    },
    release(presentationId) {
      presentations.release(presentationId);
    },
    setOverlayRegions() {},
    setModalOverlay(active) {
      presentations.setModalOverlay(active);
    },
  };

  return {
    provider,
    start() {
      createTab();
    },
    dispose() {
      accepting = false;
      for (const tab of [...tabs.values()]) disposeTab(tab);
    },
  };
}
