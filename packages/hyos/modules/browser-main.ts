import {
  BrowserWindow,
  WebContentsView,
  screen,
  type Event as ElectronEvent,
  type WebContents,
} from "electron";
import { defineModule } from "../runtime.js";
import {
  type MainRemoteCapabilities,
  type RemoteProvider,
} from "../remote-capabilities.js";
import {
  browserCapability,
  type BrowserBounds,
  type BrowserPresentation,
  type BrowserState,
  type BrowserTabState,
  type PresentationId,
  type TabId,
} from "../capabilities/browser.js";

type BrowserMainConfig = Readonly<{ initialUrl: string }>;

type Tab = {
  id: TabId;
  view: WebContentsView;
  contents: WebContents;
  error: string | null;
  attached: boolean;
  disposed: boolean;
  removeListeners: Array<() => void>;
};

function normalizeUrl(input: string | undefined): string {
  const candidate = input?.trim();
  if (!candidate) throw new Error("Enter a URL");
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)
    ? candidate
    : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }
  return url.toString();
}

function containsPoint(
  point: Readonly<{ x: number; y: number }>,
  bounds: BrowserBounds,
): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

export = defineModule<BrowserMainConfig>({
  id: "browser.main",
  inject: [
    "electron.base-window",
    "electron.overlay-window",
    "remote.capabilities",
  ],
  provide: ["browser.host"],

  apply(ctx, config) {
    const baseWindow = ctx.get<BrowserWindow>("electron.base-window");
    const overlayWindow = ctx.get<BrowserWindow>("electron.overlay-window");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const tabs = new Map<TabId, Tab>();
    const presentations = new Map<PresentationId, BrowserPresentation>();
    const generation = Date.now();
    let overlayRegions: readonly BrowserBounds[] = [];
    let activeTabId: TabId | null = null;
    let nextTabId = 1;
    let sequence = 0;
    let accepting = true;
    let passingThrough = false;

    const tabState = (tab: Tab): BrowserTabState => ({
      id: tab.id,
      url: tab.contents.getURL(),
      title: tab.contents.getTitle(),
      loading: tab.contents.isLoading(),
      canGoBack: tab.contents.navigationHistory.canGoBack(),
      canGoForward: tab.contents.navigationHistory.canGoForward(),
      error: tab.error,
    });
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
    const setPassThrough = (next: boolean): void => {
      if (overlayWindow.isDestroyed() || next === passingThrough) return;
      passingThrough = next;
      overlayWindow.setIgnoreMouseEvents(next, { forward: true });
    };
    const syncPointerOwner = (): void => {
      if (overlayWindow.isDestroyed()) return;
      const windowBounds = overlayWindow.getBounds();
      const cursor = screen.getCursorScreenPoint();
      const local = {
        x: cursor.x - windowBounds.x,
        y: cursor.y - windowBounds.y,
      };
      const overBrowser = [...presentations.values()].some(
        ({ bounds, visible }) => visible && containsPoint(local, bounds),
      );
      const overOverlay = overlayRegions.some((bounds) =>
        containsPoint(local, bounds),
      );
      setPassThrough(overBrowser && !overOverlay);
    };
    const detach = (tab: Tab): void => {
      if (!tab.attached || baseWindow.isDestroyed()) return;
      baseWindow.contentView.removeChildView(tab.view);
      tab.attached = false;
    };
    const attach = (tab: Tab, bounds: BrowserBounds): void => {
      if (!tab.attached) {
        baseWindow.contentView.addChildView(tab.view);
        tab.attached = true;
      }
      const [windowWidth, windowHeight] = baseWindow.getContentSize();
      const x = Math.max(0, Math.round(bounds.x));
      const y = Math.max(0, Math.round(bounds.y));
      tab.view.setBounds({
        x,
        y,
        width: Math.max(0, Math.min(Math.round(bounds.width), windowWidth - x)),
        height: Math.max(
          0,
          Math.min(Math.round(bounds.height), windowHeight - y),
        ),
      });
    };
    const present = (presentation: BrowserPresentation): void => {
      const tab = tabs.get(presentation.tabId);
      if (!tab) throw new Error(`Unknown browser tab: ${presentation.tabId}`);
      for (const [id, existing] of presentations) {
        if (
          id !== presentation.presentationId &&
          existing.tabId === presentation.tabId
        ) {
          presentations.delete(id);
        }
      }
      const previous = presentations.get(presentation.presentationId);
      if (previous && previous.tabId !== presentation.tabId) {
        const previousTab = tabs.get(previous.tabId);
        if (previousTab) detach(previousTab);
      }
      presentations.set(presentation.presentationId, presentation);
      if (presentation.visible) attach(tab, presentation.bounds);
      else detach(tab);
      syncPointerOwner();
    };
    const release = (presentationId: PresentationId): void => {
      const presentation = presentations.get(presentationId);
      if (!presentation) return;
      presentations.delete(presentationId);
      const tab = tabs.get(presentation.tabId);
      if (tab) detach(tab);
      syncPointerOwner();
    };
    const activateTab = (tabId: TabId): void => {
      if (!tabs.has(tabId) || activeTabId === tabId) return;
      activeTabId = tabId;
      publish();
    };
    const disposeTab = (tab: Tab): void => {
      if (tab.disposed) return;
      tab.disposed = true;
      for (const [id, presentation] of presentations) {
        if (presentation.tabId === tab.id) presentations.delete(id);
      }
      detach(tab);
      for (const removeListener of tab.removeListeners) removeListener();
      tabs.delete(tab.id);
      if (!tab.contents.isDestroyed()) tab.contents.close();
      if (activeTabId === tab.id) activeTabId = null;
    };
    const createTab = (requestedUrl = config.initialUrl): Tab => {
      const id = `tab-${nextTabId++}` as TabId;
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const tab: Tab = {
        id,
        view,
        contents: view.webContents,
        error: null,
        attached: false,
        disposed: false,
        removeListeners: [],
      };
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
        createTab(url);
        return { action: "deny" };
      });
      tabs.set(id, tab);
      activateTab(id);
      void tab.contents
        .loadURL(normalizeUrl(requestedUrl))
        .catch((error: Error) => {
          tab.error = error.message;
          publish();
        });
      return tab;
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

    const host: RemoteProvider<typeof browserCapability> = {
      async execute(command) {
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
      },
      present,
      release,
      setOverlayRegions(regions) {
        overlayRegions = regions;
        syncPointerOwner();
      },
    };

    ctx.provide("browser.host", host);
    ctx.effect(() => remote.provide(browserCapability, host));
    ctx.effect(() => {
      const timer = setInterval(syncPointerOwner, 24);
      return () => clearInterval(timer);
    });
    ctx.effect(() => () => {
      accepting = false;
      setPassThrough(false);
      for (const tab of [...tabs.values()]) disposeTab(tab);
    });
    createTab();
  },
});
