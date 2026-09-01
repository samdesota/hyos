import { WebContentsView, type Event as ElectronEvent } from "electron";
import type { BrowserTabState, TabId } from "../../capabilities/browser.js";
import type { Tab } from "./types.js";
import { normalizeUrl } from "./url.js";

type CreateTabOptions = Readonly<{
  id: TabId;
  url: string;
  publish(): void;
  openTab(url: string): void;
}>;

export function createTabView(options: CreateTabOptions): Tab {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const tab: Tab = {
    id: options.id,
    view,
    contents: view.webContents,
    error: null,
    attached: false,
    disposed: false,
    removeListeners: [],
  };
  const publish = options.publish;
  tab.contents.on("did-start-loading", publish);
  tab.contents.on("did-stop-loading", publish);
  tab.contents.on("did-navigate", publish);
  tab.contents.on("did-navigate-in-page", publish);
  tab.contents.on("page-title-updated", publish);
  tab.removeListeners.push(() => {
    tab.contents.off("did-start-loading", publish);
    tab.contents.off("did-stop-loading", publish);
    tab.contents.off("did-navigate", publish);
    tab.contents.off("did-navigate-in-page", publish);
    tab.contents.off("page-title-updated", publish);
  });
  const onFail = (
    _event: ElectronEvent,
    _code: number,
    description: string,
    _url: string,
    isMainFrame: boolean,
  ): void => {
    if (!isMainFrame) return;
    tab.error = description;
    publish();
  };
  tab.contents.on("did-fail-load", onFail);
  tab.removeListeners.push(() => {
    tab.contents.off("did-fail-load", onFail);
  });
  tab.contents.setWindowOpenHandler(({ url }) => {
    options.openTab(url);
    return { action: "deny" };
  });
  void tab.contents.loadURL(normalizeUrl(options.url)).catch((error: Error) => {
    tab.error = error.message;
    publish();
  });
  return tab;
}

export function tabState(tab: Tab): BrowserTabState {
  return {
    id: tab.id,
    url: tab.contents.getURL(),
    title: tab.contents.getTitle(),
    loading: tab.contents.isLoading(),
    canGoBack: tab.contents.navigationHistory.canGoBack(),
    canGoForward: tab.contents.navigationHistory.canGoForward(),
    error: tab.error,
  };
}

export function disposeTabView(tab: Tab): void {
  if (tab.disposed) return;
  tab.disposed = true;
  for (const removeListener of tab.removeListeners) removeListener();
  if (!tab.contents.isDestroyed()) tab.contents.close();
}
