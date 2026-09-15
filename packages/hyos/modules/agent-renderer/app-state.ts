import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type {
  AgentGlobalTabRow,
  AgentMessage,
  AgentMode,
  AgentPlanTask,
  AgentReasoningEffort,
  AgentMessageChange,
  AgentProviderSummary,
  AgentSessionSummary,
  AgentSessionTab,
  AgentSessionTabs,
} from "../../capabilities/agent.js";
import type {
  BrowserCommand,
  BrowserState,
  TabId,
} from "../../capabilities/browser.js";
import type { BrowserClient } from "../browser-client/types.js";
import type {
  AgentClient,
  AgentMessageFeed,
  KeybindingClient,
} from "./client.js";
import { createAutoScrollController } from "./auto-scroll.js";
import {
  bootDebug,
  perfLog,
  perfNow,
  tabsDebug,
  timeAsync,
} from "./perf-time.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  activeSideTab,
  TabCreateLedger,
  createdHostTabId,
  urlMatches,
  isPinnedSideTab,
  neighborSideTabId,
  pinnedSideTabs,
  reconcileSideTabs,
  restoreSessionTabs,
  unadoptedHostTab,
  unadoptedDevToolsTab,
  sideTabHostTabId,
  sideTabForHostTab,
  adoptCreatedSideTab,
  type SessionTabPlacement,
  type SideTab,
} from "./side-pane.js";
import {
  activeGlobalTab,
  neighborGlobalTabId,
  reconcileGlobalTabs,
  restoreGlobalTabs,
  snapshotGlobalTabs,
  unadoptedGlobalHostTab,
  type GlobalTab,
} from "./global-tabs.js";
import {
  createGlobalTabsPersister,
  snapshotFromRows,
} from "./global-tabs-persist.js";
import { createSessionTabsRecorder } from "./session-tabs.js";
import { selectedMode } from "./mode-selection.js";
import {
  collapseWorkRuns,
  implementNextPrompt,
  orderedFolders,
  partitionSessions,
  patchEntries,
  planPanelIndex,
  recentFolders,
  sessionsShallowEqual,
  timelineEntries,
} from "./sessions-model.js";

export type AppStateProps = Readonly<{
  client: AgentClient;
  keybindingClient: KeybindingClient;
  browserClient: BrowserClient;
  /**
   * Route change request: the URL is the source of truth for which session
   * (or the new-session view) is open, so selection actions navigate
   * instead of writing the hash directly.
   */
  navigateToSession: (sessionId: string | null) => void;
  /**
   * Route change request for the global tab strip: the URL is the source of
   * truth for which global tab (if any) is focused, so focus actions
   * navigate instead of writing the hash directly. Null drops tab focus.
   */
  navigateToGlobalTab: (tabId: string | null) => void;
}>;

/**
 * Shared app-wide state and actions: agent providers/sessions, the active
 * session's message feed, browser host state, and the global tab strip.
 * Created once inside the app root (its effects and cleanup register
 * against the owning component) and threaded down to route components.
 */
export function createAppState({
  client,
  keybindingClient,
  browserClient,
  navigateToSession,
  navigateToGlobalTab,
}: AppStateProps) {
  const [providers, setProviders] = createSignal<
    readonly AgentProviderSummary[]
  >([]);
  const [sessions, setSessions] = createSignal<readonly AgentSessionSummary[]>(
    [],
  );
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [messages, setMessages] = createSignal<readonly AgentMessage[]>([]);
  const [before, setBefore] = createSignal<{
    createdAt: Date;
    id: string;
  } | null>(null);
  const [hasOlder, setHasOlder] = createSignal(false);
  const [loadingFeed, setLoadingFeed] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [prompt, setPrompt] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [providerId, setProviderId] = createSignal("");
  const [modelId, setModelId] = createSignal("");
  const [reasoningEffort, setReasoningEffort] =
    createSignal<AgentReasoningEffort | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [newMode, setNewMode] = createSignal<AgentMode>("incremental");
  const [modeDrafts, setModeDrafts] = createSignal<Record<string, AgentMode>>(
    {},
  );
  const [effortDrafts, setEffortDrafts] = createSignal<
    Record<string, AgentReasoningEffort | null>
  >({});
  const [followupMenuOpen, setFollowupMenuOpen] = createSignal(false);
  const [folderMenuOpen, setFolderMenuOpen] = createSignal(false);

  // Create-modal open state lives app-wide so app-level accelerators can
  // drive it, not just the sidebar button. Register Cmd/Ctrl+T once; the
  // keybinding.main module intercepts the keystroke (even inside browser
  // tabs) and reports it back as a `triggered` event.
  const [createOpen, setCreateOpen] = createSignal(false);
  const createOpenAction = "create.open";
  void keybindingClient
    .register({ action: createOpenAction, accelerator: "CmdOrCtrl+T" })
    .catch((error) => console.error("[keybinding] register failed", error));
  const unsubscribeCreateTriggered = keybindingClient.onTriggered(
    ({ action }) => {
      if (action === createOpenAction) setCreateOpen(true);
    },
  );
  onCleanup(() => {
    unsubscribeCreateTriggered();
    void keybindingClient.unregister(createOpenAction).catch(() => undefined);
  });
  // Folder sidebar state (manual order + collapse) is persisted host-side in
  // hydb; these signals mirror the last state the host published. Null order
  // means nothing persisted yet — folders render in newest-session order.
  const [folderOrder, setFolderOrder] = createSignal<readonly string[] | null>(
    null,
  );
  const [collapsedFolders, setCollapsedFolders] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const persistFolderOrder = (order: readonly string[]): void => {
    // Optimistic: the host echoes the change through the folderState ping.
    setFolderOrder(order);
    void client
      .execute({ type: "reorder-folders", orderedFolders: [...order] })
      .catch(() => undefined);
  };
  const setFolderCollapsed = (folder: string, collapsed: boolean): void => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous);
      if (collapsed) next.add(folder);
      else next.delete(folder);
      return next;
    });
    void client
      .execute({ type: "set-folder-collapsed", folder, collapsed })
      .catch(() => undefined);
  };
  const recentFoldersList = createMemo(() =>
    orderedFolders(recentFolders(sessions()), folderOrder()),
  );
  const initialMode = () => selectedMode(providerId(), newMode());
  const followupMode = () => {
    const session = activeSession();
    return selectedMode(
      session?.providerId ?? "",
      session?.mode,
      modeDrafts()[session?.id ?? ""],
    );
  };
  const followupEffort = (): AgentReasoningEffort | null => {
    const session = activeSession();
    const draft = effortDrafts()[session?.id ?? ""];
    return draft !== undefined ? draft : (session?.reasoningEffort ?? null);
  };
  const setFollowupEffort = (effort: AgentReasoningEffort | null): void => {
    if (activeId())
      setEffortDrafts((drafts) => ({ ...drafts, [activeId()!]: effort }));
  };
  const activeSessionModel = () => {
    const session = activeSession();
    const provider = providers().find(({ id }) => id === session?.providerId);
    const model = provider?.models.find(({ id }) => id === session?.modelId);
    return model ? { provider: provider!, model } : null;
  };
  const setMode = (followup: boolean, mode: AgentMode): void => {
    if (followup && activeId())
      setModeDrafts((drafts) => ({ ...drafts, [activeId()!]: mode }));
    else setNewMode(mode);
  };
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const transcriptScroll = createAutoScrollController();
  const patchScroll = createAutoScrollController();
  const narrowSide = window.matchMedia("(max-width: 1080px)");
  const [sideCollapsed, setSideCollapsed] = createSignal(narrowSide.matches);
  const [sideTabs, setSideTabs] =
    createSignal<readonly SideTab[]>(pinnedSideTabs);
  const [activeSideTabId, setActiveSideTabId] = createSignal<string | null>(
    "patches",
  );
  const [browserState, setBrowserState] = createSignal(emptyBrowserState);
  const [browserError, setBrowserError] = createSignal<string | null>(null);

  // The app-level global tab strip: presentation surfaces owned by the app
  // rather than any session. Tabs the host no longer knows are dropped on
  // every publish, so a closed page cannot linger in the strip.
  const [globalTabs, setGlobalTabs] = createSignal<readonly GlobalTab[]>([]);
  const [activeGlobalTabId, setActiveGlobalTabId] = createSignal<string | null>(
    null,
  );
  const focusedGlobalTab = createMemo(() =>
    activeGlobalTab(globalTabs(), activeGlobalTabId()),
  );
  // `+` focuses a host tab the strip does not already show, and only asks
  // the host to create one once every host tab is in the strip; a created
  // tab lands in the strip through the diff against the pre-call state.
  const openGlobalTab = async (): Promise<void> => {
    const adoptable = unadoptedGlobalHostTab(browserState(), globalTabs());
    if (adoptable) {
      setGlobalTabs((tabs) => [
        ...tabs,
        { id: `global-${adoptable.id}`, kind: "browser", tabId: adoptable.id },
      ]);
      navigateToGlobalTab(`global-${adoptable.id}`);
      return;
    }
    const before = browserState();
    const next = await runBrowser({ type: "create-tab" });
    const tabId = next ? createdHostTabId(before, next) : null;
    if (!tabId) return;
    setGlobalTabs((tabs) =>
      tabs.some((tab) => tab.kind === "browser" && tab.tabId === tabId)
        ? tabs
        : [...tabs, { id: `global-${tabId}`, kind: "browser", tabId }],
    );
    navigateToGlobalTab(`global-${tabId}`);
  };
  // A whiteboard tab is a view onto a persisted board, identified up front
  // by uuid: the tab holds only the boardId, so closing it drops the view
  // while the board itself outlives the strip (persistence lands with the
  // boards schema). Reopening an open board's tab focuses it instead of
  // forking the strip.
  const openWhiteboardTab = (boardId: string): void => {
    const existing = globalTabs().find(
      (tab) => tab.kind === "whiteboard" && tab.boardId === boardId,
    );
    if (existing) {
      navigateToGlobalTab(existing.id);
      return;
    }
    const id = `global-whiteboard-${boardId}`;
    setGlobalTabs((tabs) =>
      tabs.some((tab) => tab.id === id)
        ? tabs
        : [...tabs, { id, kind: "whiteboard", boardId }],
    );
    navigateToGlobalTab(id);
  };
  const closeGlobalTab = (tab: GlobalTab): void => {
    const neighborId = neighborGlobalTabId(globalTabs(), tab.id);
    setGlobalTabs((tabs) => tabs.filter(({ id }) => id !== tab.id));
    if (activeGlobalTabId() === tab.id) navigateToGlobalTab(neighborId);
    // Closing retires the page for real: the host tab goes with it, so the
    // strip (and any session pane showing it) reconciles it away.
    if (tab.kind === "browser") {
      void runBrowser({ type: "close-tab", tabId: tab.tabId });
    }
  };

  // Persisted global strip: the app-level tabs survive restarts through the
  // agent global-tabs table. Host publishes churn titles on every loading
  // tick, so writes are debounced and the snapshot is taken when the write
  // fires — never when scheduled. `lastSavedGlobalJson` remembers exactly
  // what this renderer last persisted, so the change event our own write
  // triggers (an echo) is recognized and ignored on its way back.
  let lastSavedGlobalJson: string | null = null;
  const globalTabsPersister = createGlobalTabsPersister({
    delay: 500,
    snapshot: () =>
      snapshotGlobalTabs(
        { tabs: globalTabs(), activeId: activeGlobalTabId() },
        browserState(),
      ),
    save: (rows) => {
      const json = JSON.stringify(snapshotFromRows(rows));
      return client.replaceGlobalTabs(rows).then(() => {
        lastSavedGlobalJson = json;
      });
    },
  });
  // Every strip mutation — open/close, focus changes, reconciliation-driven
  // title drift — coalesces into one debounced write.
  createEffect(() => {
    void globalTabs();
    void activeGlobalTabId();
    void browserState();
    globalTabsPersister.request();
  });

  // Persisted pane state as intent deltas: the record is the only durable
  // truth for a session's tabs, and it changes only when the user or an
  // agent opens, closes, or focuses a tab — never as a side effect of host
  // publishes, scope swaps, or teardown. Each delta composes onto the
  // record merged with the visible strip, so an empty record this renderer
  // did not cause cannot erase what is on screen.
  const stripTabEntries = (): AgentSessionTab[] => {
    const byTabId = new Map(browserState().tabs.map((tab) => [tab.id, tab]));
    return sideTabs().flatMap((tab) => {
      const tabId = sideTabHostTabId(tab);
      if (tabId === null) return [];
      const hostTab = byTabId.get(tabId);
      return hostTab
        ? [{ kind: "browser" as const, tabId, url: hostTab.url }]
        : [];
    });
  };
  const tabsRecorder = createSessionTabsRecorder({
    load: (sessionId) => client.sessionTabs(sessionId),
    save: (sessionId, tabs) => client.saveSessionTabs(sessionId, tabs),
    visibleTabs: (sessionId) =>
      sessionId === activeId() ? stripTabEntries() : [],
  });
  const recordTabOpened = (tabId: TabId, url: string | undefined): void => {
    const sessionId = activeId();
    if (!sessionId || !url) return;
    tabsRecorder.opened(sessionId, tabId, url);
  };

  // Selecting a session (or the new-session view) resets the pane to its
  // pinned tab; the projection then rebuilds the strip from the session's
  // persisted record — the record replaces the old in-memory scope stash,
  // while the session's host pages keep running in the background and are
  // re-adopted by id on the next projection.
  const resetSideTabs = (): void => {
    setSideTabs(pinnedSideTabs);
    setActiveSideTabId("patches");
  };

  // Scroll containers live in the view layer; the feed registers them so
  // message changes can keep the live content pinned to the bottom.
  let transcript: HTMLDivElement | undefined;
  let patchList: HTMLDivElement | undefined;
  const setTranscriptElement = (element: HTMLDivElement): void => {
    transcript = element;
  };
  const setPatchListElement = (element: HTMLDivElement): void => {
    patchList = element;
  };
  const transcriptElement = () => transcript;
  const patchListElement = () => patchList;

  let feed: AgentMessageFeed | undefined;
  let unsubscribeFeed: (() => void) | undefined;
  let feedGeneration = 0;
  let sessionSequence = -1;

  const activeSession = createMemo(() =>
    sessions().find(({ id }) => id === activeId()),
  );
  const partitioned = createMemo(() => partitionSessions(sessions()));
  const activeSessions = () => partitioned().active;
  const archivedSessions = () => partitioned().archived;
  const [archivedOpen, setArchivedOpen] = createSignal(false);
  const selectedProvider = createMemo(() =>
    providers().find(({ id }) => id === providerId()),
  );
  const selectedModel = createMemo(() =>
    selectedProvider()?.models.find(({ id }) => id === modelId()),
  );
  const timeline = createMemo(() =>
    collapseWorkRuns(timelineEntries(messages())),
  );
  const patches = createMemo(() => patchEntries(messages()));
  const sideActive = createMemo(() =>
    activeSideTab(sideTabs(), activeSideTabId()),
  );
  const activeBrowserTab = createMemo(() => {
    const tab = sideActive();
    return tab?.kind === "browser" || tab?.kind === "devtools" ? tab : null;
  });
  const activePlan = createMemo(() => activeSession()?.plan ?? null);
  const planAfterIndex = createMemo(() =>
    activePlan() ? planPanelIndex(timeline()) : -1,
  );

  // Latest recorded context usage for the active session, from the most
  // recent assistant message that carries it.
  const latestUsage = createMemo(() => {
    const list = messages();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].usage) return list[i].usage;
    }
    return null;
  });

  const collapseSideWhenNarrow = (event: MediaQueryListEvent): void => {
    if (event.matches) setSideCollapsed(true);
  };
  narrowSide.addEventListener("change", collapseSideWhenNarrow);

  // Browser host state drives the strip's browser tabs: every publish also
  // reconciles, so tabs closed or lost to a browser.main hot reload
  // disappear from the strip instead of presenting a dead view. Tabs that
  // appear on their own — an agent's browser_open_tab, say — are adopted
  // through the session strip subscription below, never here: adoption is
  // driven by the persisted strip, so it cannot steal focus on an unrelated
  // publish tick.
  let browserPublishCount = 0;
  const acceptBrowserState = (next: BrowserState): void => {
    browserPublishCount += 1;
    if (
      browserPublishCount <= 4 ||
      (browserPublishCount & (browserPublishCount - 1)) === 0
    )
      bootDebug(
        `agent-renderer browser-state count=${browserPublishCount} tabs=${next.tabs.length}`,
      );
    setBrowserState(next);
    setSideTabs((tabs) => {
      const kept = reconcileSideTabs(tabs, next);
      const dropped = tabs.length - kept.length;
      if (dropped > 0)
        tabsDebug(
          `reconcile: host gen=${next.generation} dropped ${dropped} browser tab(s) from strip`,
        );
      return kept;
    });
    setGlobalTabs((tabs) => reconcileGlobalTabs(tabs, next));
  };
  const unsubscribeBrowser = browserClient.subscribe(acceptBrowserState);
  onCleanup(() => unsubscribeBrowser());
  const bootBrowserSnapshot: Promise<void> = browserClient
    .execute({ type: "snapshot" })
    .then((state) => {
      bootDebug("agent-renderer browser-snapshot:resolved");
      acceptBrowserState(state);
    })
    // A boot-time failure (host unloading) shows up in the browser tab
    // content instead of leaving a silently dead strip.
    .catch((value: unknown) => {
      setBrowserError(value instanceof Error ? value.message : String(value));
    });

  const runBrowser = async (
    command: BrowserCommand,
  ): Promise<BrowserState | null> => {
    setBrowserError(null);
    try {
      const next = await browserClient.execute(command);
      acceptBrowserState(next);
      return next;
    } catch (value) {
      setBrowserError(value instanceof Error ? value.message : String(value));
      return null;
    }
  };

  // Keep the host's active tab on the focused strip tab so toolbar commands
  // (navigate, back, …) address the page the pane is showing. A focused
  // global tab owns the host's active tab while it is up; the session pane
  // yields so the two strips cannot fight over activation.
  createEffect(() => {
    const tab = sideActive();
    if (tab?.kind !== "browser" && tab?.kind !== "devtools") return;
    if (focusedGlobalTab()) return;
    if (browserState().activeTabId === tab.tabId) return;
    void runBrowser({ type: "activate-tab", tabId: tab.tabId });
  });

  // Same for the global strip: focusing a global browser tab makes it the
  // host's active tab so its toolbar drives the page the main area shows.
  createEffect(() => {
    const tab = focusedGlobalTab();
    if (tab?.kind !== "browser") return;
    if (browserState().activeTabId === tab.tabId) return;
    void runBrowser({ type: "activate-tab", tabId: tab.tabId });
  });

  // `+` focuses a host tab the strip does not already show, and only creates
  // a new one once every host tab is already in the strip; a created tab is
  // appended here — adoption otherwise happens only through the session
  // strip subscription.
  const openBrowserSideTab = (): void => {
    const adoptable = unadoptedHostTab(browserState(), sideTabs());
    if (adoptable) {
      setSideTabs((tabs) => [
        ...tabs,
        sideTabForHostTab(adoptable.id, adoptable.url),
      ]);
      setActiveSideTabId(adoptable.id);
      recordTabOpened(adoptable.id, adoptable.url);
      setSideCollapsed(false);
      return;
    }
    // Every page tab is already in the strip: adopt a DevTools frontend tab
    // the host holds (an openCdpTarget pane) before creating a fresh page.
    const devtools = unadoptedDevToolsTab(browserState(), sideTabs());
    if (devtools) {
      setSideTabs((tabs) => [
        ...tabs,
        sideTabForHostTab(devtools.id, devtools.url),
      ]);
      setActiveSideTabId(devtools.id);
      recordTabOpened(devtools.id, devtools.url);
      setSideCollapsed(false);
      return;
    }
    const before = browserState();
    void runBrowser({ type: "create-tab" }).then((next) => {
      const tabId = next ? createdHostTabId(before, next) : null;
      if (!tabId) return;
      setSideTabs((tabs) => adoptCreatedSideTab(tabs, tabId));
      setActiveSideTabId(tabId);
      recordTabOpened(tabId, next?.tabs.find(({ id }) => id === tabId)?.url);
    });
  };

  // Opening a link from the session's markdown creates a host tab showing
  // that url and appends it to the session's strip, focused — same lifecycle
  // as a `+`-created tab (host presentation, reconciliation, persistence).
  const openUrlSideTab = (url: string): void => {
    const before = browserState();
    setSideCollapsed(false);
    void runBrowser({ type: "create-tab", url }).then((next) => {
      const tabId = next ? createdHostTabId(before, next) : null;
      if (!tabId) return;
      setSideTabs((tabs) => adoptCreatedSideTab(tabs, tabId));
      setActiveSideTabId(tabId);
      recordTabOpened(tabId, url);
    });
  };

  const closeSideTab = (tab: SideTab): void => {
    if (isPinnedSideTab(tab)) return;
    const neighborId = neighborSideTabId(sideTabs(), tab.id);
    setSideTabs((tabs) => tabs.filter(({ id }) => id !== tab.id));
    if (activeSideTabId() === tab.id) {
      setActiveSideTabId(neighborId ?? "patches");
    }
    // Closing the host tab releases its presentation and, when it was the
    // last one, makes the host recreate a fresh tab for the next `+` click.
    if (tab.kind === "browser" || tab.kind === "devtools") {
      const sessionId = activeId();
      if (sessionId) tabsRecorder.closed(sessionId, tab.tabId);
      createLedger.forget(tab.tabId);
      void runBrowser({ type: "close-tab", tabId: tab.tabId });
    }
  };

  // A user click focuses a strip tab and records the focus delta;
  // programmatic focus (projection re-asserting the saved focus, close
  // fallbacks) goes through setActiveSideTabId directly and never writes
  // the record.
  const focusSideTab = (tabId: string): void => {
    setActiveSideTabId(tabId);
    const sessionId = activeId();
    if (sessionId) tabsRecorder.focused(sessionId, tabId);
  };

  createEffect(() => {
    const available = providers();
    if (available.length === 0) return;
    if (!available.some(({ id }) => id === providerId())) {
      setProviderId(available[0].id);
    }
  });
  createEffect(() => {
    const models = selectedProvider()?.models ?? [];
    if (models.length === 0) return;
    if (!models.some(({ id }) => id === modelId())) setModelId(models[0].id);
  });
  createEffect(() => {
    if (folder()) return;
    const latest = recentFoldersList()[0];
    if (latest) setFolder(latest);
  });
  createEffect(() => {
    const model = selectedProvider()?.models.find(({ id }) => id === modelId());
    const efforts = model?.reasoningEfforts ?? [];
    if (efforts.length === 0) {
      setReasoningEffort(null);
    } else if (!reasoningEffort() || !efforts.includes(reasoningEffort()!)) {
      setReasoningEffort(model?.defaultReasoningEffort ?? efforts[0]);
    }
  });

  const showError = (value: unknown): void => {
    setError(value instanceof Error ? value.message : String(value));
  };

  const acceptSessions = (state: {
    sequence: number;
    sessions: readonly AgentSessionSummary[];
  }): void => {
    if (state.sequence < sessionSequence) return;
    sessionSequence = state.sequence;
    // The host re-sends the full list on every tick; only touch the signal
    // when something actually changed, so the sidebar DOM isn't torn down
    // mid-interaction (hover/×  flashing, broken clicks while streaming).
    if (sessionsShallowEqual(sessions(), state.sessions)) return;
    setSessions(state.sessions);
  };

  // Live session-list updates: without this the sidebar only learns of
  // status changes (e.g. a session starting to run) on a manual reload.
  const unsubscribeSessions = client.subscribeSessions(acceptSessions);
  onCleanup(() => unsubscribeSessions());

  const queueScrollToBottom = (
    controller: ReturnType<typeof createAutoScrollController>,
    container: () => HTMLDivElement | undefined,
  ): void => {
    const current = container();
    if (current && !controller.shouldFollow(current)) return;
    const settle = (frames: number): void => {
      requestAnimationFrame(() => {
        const next = container();
        if (!next || !controller.shouldFollow(next)) return;
        controller.pin();
        next.scrollTop = next.scrollHeight;
        // Tool activity (diffs, code blocks, run collapse) can shift layout
        // a frame or more after the change lands; keep settling briefly.
        if (frames > 0) settle(frames - 1);
      });
    };
    settle(3);
  };

  const followLiveContent = (): void => {
    queueScrollToBottom(transcriptScroll, () => transcript);
    queueScrollToBottom(patchScroll, () => patchList);
  };

  // Timestamp of the in-flight send, for the send:user-visible perf trace.
  let sendStartedAt = 0;

  const applyMessageChange = (change: AgentMessageChange): void => {
    setMessages((current) => {
      if (change.type === "message-created") {
        if (current.some(({ id }) => id === change.message.id)) return current;
        if (change.message.role === "user")
          perfLog("send:user-visible", perfNow() - sendStartedAt);
        return [...current, change.message];
      }
      if (change.type === "message-replaced") {
        return current.map((message) =>
          message.id === change.message.id ? change.message : message,
        );
      }
      return current.map((message) => {
        if (message.id !== change.messageId) return message;
        if (change.type === "content-appended") {
          return {
            ...message,
            content: message.content + change.content,
            updatedAt: change.updatedAt,
          };
        }
        return {
          ...message,
          status: change.status,
          lastError: change.lastError,
          updatedAt: change.updatedAt,
        };
      });
    });
    followLiveContent();
  };

  const closeFeed = (): void => {
    unsubscribeFeed?.();
    unsubscribeFeed = undefined;
    feed?.close();
    feed = undefined;
  };

  // Cross-projection create ledger: a create-tab is async and projections
  // re-run on record events, so without this each overlapping pass would
  // open the same page again. Single-flight per normalized url, and the
  // produced tab is remembered so later passes adopt it instead of copying.
  const createLedger = new TabCreateLedger();

  // Resolve saved strip placements against the live host state: reuse tabs
  // that already show the url — another surface (the agent's own create-tab,
  // or an earlier placement) may have opened it after the placements were
  // computed — and open the rest fresh. `isStale` abandons the work the
  // moment the strip being built belongs to a session no longer shown; the
  // tabs opened in the meantime are closed again.
  const resolvePlacements = async (
    placements: readonly SessionTabPlacement[],
    isStale: () => boolean,
  ): Promise<readonly (TabId | null)[]> => {
    const claimed = new Set<TabId>();
    const created: TabId[] = [];
    const tabIds: (TabId | null)[] = [];
    for (const placement of placements) {
      let tabId: TabId | null = null;
      if (placement.kind === "reuse") {
        tabId = placement.tabId;
      } else {
        const remembered = createLedger.createdFor(placement.url);
        const live = browserState().tabs.find(
          ({ id, url }) =>
            !claimed.has(id) &&
            (id === remembered || urlMatches(url, placement.url)),
        );
        if (live) {
          tabsDebug(`resolve: url match ${placement.url} -> ${live.id}`);
          tabId = live.id;
        } else if (remembered) {
          // A previous pass already created this page and its tab has not
          // surfaced in the host snapshot yet — pending, not missing.
          tabsDebug(
            `resolve: pending create ${placement.url} -> ${remembered}`,
          );
          tabId = remembered;
        } else {
          tabsDebug(`resolve: create-tab ${placement.url}`);
          tabId = await createLedger.createOnce(placement.url, async () => {
            const before = browserState();
            const next = await runBrowser({
              type: "create-tab",
              url: placement.url,
            });
            return next ? createdHostTabId(before, next) : null;
          });
          tabsDebug(
            `resolve: created ${placement.url} -> ${tabId ?? "FAILED"}`,
          );
          if (tabId) created.push(tabId);
        }
      }
      if (tabId) claimed.add(tabId);
      if (isStale()) {
        tabsDebug(
          `resolve: stale mid-loop, closing orphans [${created.join(",")}]`,
        );
        for (const orphan of created) {
          void runBrowser({ type: "close-tab", tabId: orphan });
        }
        return [];
      }
      tabIds.push(tabId);
    }
    return tabIds;
  };

  // Append the resolved tabs to the strip (idempotent: a `+` click or an
  // earlier pass may have landed one already) and re-assert the saved
  // focus. Never expands a collapsed pane — what to look at is the user's
  // call; the strip simply reflects the session's persisted state. The
  // resolved host tab ids are written back to the record: a created tab
  // (stale persisted id) must not be re-created on the next projection.
  const adoptResolvedTabs = (
    sessionId: string,
    tabIds: readonly (TabId | null)[],
    focusedId: TabId | null,
  ): void => {
    setSideTabs((tabs) => {
      const shown = new Set(
        tabs.flatMap((tab) =>
          tab.kind === "browser" || tab.kind === "devtools" ? [tab.tabId] : [],
        ),
      );
      const byTabId = new Map(
        browserState().tabs.map((hostTab) => [hostTab.id, hostTab]),
      );
      const additions = tabIds
        .filter((tabId): tabId is TabId => tabId !== null && !shown.has(tabId))
        .map((tabId) => sideTabForHostTab(tabId, byTabId.get(tabId)?.url));
      tabsDebug(
        `adopt: shown=[${[...shown].join(",")}] additions=[${additions
          .map((a) => sideTabHostTabId(a))
          .join(",")}] focus=${focusedId}`,
      );
      return additions.length === 0 ? tabs : [...tabs, ...additions];
    });
    tabsRecorder.resolved(sessionId, tabIds);
    tabsDebug(`adopt: resolved writeback [${tabIds.join(",")}]`);
    if (focusedId) setActiveSideTabId(focusedId);
  };

  // Projection: the one path that builds the session pane's strip from the
  // persisted record. Selecting a session and a persisted-strip change (the
  // agent's browser_open_tab, another renderer's write, …) both land here,
  // and it is idempotent and re-runnable: a re-select of the same session
  // simply re-runs it instead of being latched to a one-time restore.
  // Adoption is appending-only, so a projection can never close or reorder
  // what the user already has up — a stale or empty record event is a
  // no-op on the live strip. A projection is abandoned only when a newer
  // one supersedes it or its session is no longer shown; the tabs it opened
  // in the meantime are closed again.
  let projectToken = 0;
  const runProject = async (sessionId: string): Promise<void> => {
    const token = ++projectToken;
    const isStale = (): boolean =>
      token !== projectToken || sessionId !== activeId();
    let saved: AgentSessionTabs | null = null;
    try {
      saved = await timeAsync(
        `session-open:tab-restore-fetch(${sessionId})`,
        () => client.sessionTabs(sessionId),
      );
    } catch (value) {
      tabsDebug(`project: sessionTabs fetch failed — ${String(value)}`);
      // Background pane state: a failed load just leaves the strip as-is.
      return;
    }
    // A renderer reload keeps the host's tabs alive, but the boot snapshot
    // revealing them may still be in flight; projecting against it keeps a
    // fast reopen from opening duplicates for tabs that never went away.
    tabsDebug(
      `project: fetched session=${sessionId} savedTabs=${saved?.tabs.length ?? 0} focus=${saved?.activeIndex}`,
    );
    await bootBrowserSnapshot;
    if (isStale() || !saved) {
      tabsDebug(
        `project: abandoned before resolve — session=${sessionId} stale=${isStale()} noSaved=${!saved}`,
      );
      return;
    }
    const { placements, activeIndex } = restoreSessionTabs(
      saved,
      browserState(),
    );
    tabsDebug(
      `project: placements session=${sessionId} hostGen=${browserState().generation} ` +
        placements
          .map((p) =>
            p.kind === "reuse" ? `reuse:${p.tabId}` : `create:${p.url}`,
          )
          .join(",") +
        ` focus=${activeIndex}`,
    );
    const tabIds = await resolvePlacements(placements, isStale);
    if (isStale()) {
      tabsDebug(
        `project: abandoned after resolve — session=${sessionId} stale`,
      );
      return;
    }
    tabsDebug(
      `project: adopting session=${sessionId} tabIds=[${tabIds.join(",")}]`,
    );
    adoptResolvedTabs(
      sessionId,
      tabIds,
      activeIndex >= 0 ? (tabIds[activeIndex] ?? null) : null,
    );
  };
  // Concurrent re-entry guard, per session: a selection and an external
  // strip event can both ask for the same session while its projection is
  // still mid-flight (between record fetch and tab creation). Two
  // overlapping projections would each see the persisted ids missing and
  // both open the tabs — a duplicate burst. A re-entrant call therefore
  // never starts a second concurrent run: if one is in flight it queues
  // exactly one trailing re-run, so the (idempotent) projection still
  // executes once more against whatever the record looks like after the
  // in-flight pass settles.
  const projectInFlight = new Map<string, Promise<void>>();
  const projectQueued = new Set<string>();
  const projectSession = (sessionId: string): Promise<void> => {
    const inFlight = projectInFlight.get(sessionId);
    if (inFlight) {
      tabsDebug(
        `project: re-entry while in flight session=${sessionId} queued=${projectQueued.has(sessionId)}`,
      );
      if (!projectQueued.has(sessionId)) {
        projectQueued.add(sessionId);
        void inFlight
          .catch(() => undefined)
          .then(() => {
            projectQueued.delete(sessionId);
            if (sessionId === activeId()) return projectSession(sessionId);
          });
      }
      return inFlight;
    }
    const run = runProject(sessionId).finally(() =>
      projectInFlight.delete(sessionId),
    );
    projectInFlight.set(sessionId, run);
    return run;
  };
  const unsubscribeSessionTabs = client.subscribeSessionTabs(
    ({ sessionId, tabs }) => {
      // An event whose payload is exactly what this renderer last wrote is
      // our own record write echoing back — a projection's `resolved`
      // writeback, a merge healing a stale id, an opened/closed/focused
      // delta the strip already reflects. Re-projecting on it turns the
      // projection into a feedback loop that multiplies tabs when pages
      // churn their urls; only genuinely external changes re-project.
      if (tabsRecorder.isOwnWrite(sessionId, tabs)) {
        tabsDebug(`strip-event: own write, skipped session=${sessionId}`);
        return;
      }
      tabsDebug(
        `strip-event: session=${sessionId} tabs=${tabs?.tabs.length ?? 0} active=${sessionId === activeId()}`,
      );
      if (sessionId === activeId()) void projectSession(sessionId);
    },
  );
  onCleanup(() => unsubscribeSessionTabs());

  // The persisted global strip, applied: browser placements resolve against
  // the live host (reuse-by-url, else open fresh — mirroring the session
  // restore), whiteboard placements rehydrate from their stable boardId.
  // An event whose snapshot is exactly what this renderer last wrote is our
  // own write echoing back and is skipped, so the apply cannot fight the
  // strip the user is editing.
  const applyGlobalTabsRows = async (
    rows: readonly AgentGlobalTabRow[],
  ): Promise<void> => {
    const snapshot = snapshotFromRows(rows);
    if (JSON.stringify(snapshot) === lastSavedGlobalJson) return;
    // The boot snapshot may still be in flight; restoring against it keeps
    // a reload from opening duplicates for tabs that never went away.
    await bootBrowserSnapshot;
    const { placements, activeIndex } = restoreGlobalTabs(
      snapshot,
      browserState(),
    );
    const tabs: GlobalTab[] = [];
    for (const placement of placements) {
      if (placement.kind === "whiteboard") {
        tabs.push({
          id: `global-whiteboard-${placement.boardId}`,
          kind: "whiteboard",
          boardId: placement.boardId,
        });
        continue;
      }
      if (placement.kind === "reuse") {
        tabs.push({
          id: `global-${placement.tabId}`,
          kind: "browser",
          tabId: placement.tabId,
        });
        continue;
      }
      const before = browserState();
      const next = await runBrowser({
        type: "create-tab",
        url: placement.url,
      });
      const tabId = next ? createdHostTabId(before, next) : null;
      if (tabId) {
        tabs.push({ id: `global-${tabId}`, kind: "browser", tabId });
      }
    }
    setGlobalTabs(tabs);
    setActiveGlobalTabId(tabs[activeIndex]?.id ?? null);
  };

  const refreshGlobalTabs = (): void => {
    void client
      .globalTabs()
      .then(applyGlobalTabsRows)
      .catch(() => undefined); // background pane state; leave the strip as-is
  };

  // Boot restore: the first load of the persisted strip brings the tabs
  // back after a restart (the debounced persister then keeps the DB fresh).
  void bootBrowserSnapshot.then(refreshGlobalTabs);

  // Live apply: another renderer (or a future writer) changing the strip
  // lands here; the store suppresses no-op writes, so only real changes
  // fire, and the echo of our own debounced write is swallowed above.
  const unsubscribeGlobalTabs = client.subscribeGlobalTabs(refreshGlobalTabs);
  onCleanup(() => unsubscribeGlobalTabs());

  const applyFolderState = (
    rows: readonly {
      folder: string;
      position: number | null;
      collapsed: boolean;
    }[],
  ): void => {
    // Row order already sorts manually-positioned folders first; mirror it
    // verbatim so orderedFolderGroups sees the saved order.
    setFolderOrder(rows.map((row) => row.folder));
    setCollapsedFolders(
      new Set(rows.filter((row) => row.collapsed).map((row) => row.folder)),
    );
  };
  const refreshFolderState = (): void => {
    void client
      .folderState()
      .then(applyFolderState)
      .catch(() => undefined); // background sidebar state; leave as-is
  };
  void bootBrowserSnapshot.then(refreshFolderState);
  const unsubscribeFolderState =
    client.subscribeFolderState(refreshFolderState);
  onCleanup(() => unsubscribeFolderState());

  const selectSession = async (sessionId: string): Promise<void> => {
    const selectStart = perfNow();
    let feedOpenDone = 0;
    const generation = ++feedGeneration;
    closeFeed();
    resetSideTabs();
    setActiveId(sessionId);
    markSessionSeen(sessionId);
    navigateToSession(sessionId);
    setPrompt("");
    setMessages([]);
    setBefore(null);
    setHasOlder(false);
    setLoadingFeed(true);
    setError(null);
    transcriptScroll.reset();
    patchScroll.reset();
    // Every selection projects the session's strip from the persisted
    // record — including a re-select of the session already active, which
    // simply re-runs the (idempotent, appending-only) projection.
    tabsDebug(
      `select: session=${sessionId} wasActive=${sessionId === activeId()}`,
    );
    void timeAsync(`session-open:tab-restore(${sessionId})`, () =>
      projectSession(sessionId),
    );
    try {
      const opened = await timeAsync(
        `session-open:openFeed(${sessionId})`,
        () => client.openFeed(sessionId, 200),
      );
      if (generation !== feedGeneration) {
        opened.close();
        return;
      }
      feed = opened;
      setMessages(opened.initial.messages);
      setBefore(opened.initial.before);
      setHasOlder(opened.initial.hasOlder);
      unsubscribeFeed = opened.subscribe(applyMessageChange);
      followLiveContent();
    } catch (value) {
      showError(value);
    } finally {
      if (generation === feedGeneration) {
        setLoadingFeed(false);
        feedOpenDone = perfNow();
        perfLog(`session-open:total(${sessionId})`, feedOpenDone - selectStart);
      }
    }
  };

  const newSession = (): void => {
    feedGeneration += 1;
    closeFeed();
    resetSideTabs();
    setActiveId(null);
    navigateToSession(null);
    setMessages([]);
    setPrompt("");
    setError(null);
    setModelMenuOpen(false);
  };

  const chooseFolder = async (): Promise<void> => {
    setError(null);
    try {
      const result = await client.execute({ type: "choose-folder" });
      if (result.type === "folder-selected" && result.folder) {
        setFolder(result.folder);
      }
    } catch (value) {
      showError(value);
    }
  };

  const INVESTIGATE_DIRECTIVE =
    "[Investigate only. Do not modify any files; use read-only commands, unless a reversible test is genuinely needed.]";

  const startSession = async (): Promise<void> => {
    if (!prompt().trim() || !folder() || !providerId() || !modelId()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.execute({
        type: "start-session",
        prompt: `${INVESTIGATE_DIRECTIVE}\n\n${prompt().trim()}`,
        folder: folder(),
        providerId: providerId(),
        modelId: modelId(),
        reasoningEffort: reasoningEffort(),
        mode: initialMode(),
        intent: "investigate",
      });
      if (result.type === "session-started") {
        setPrompt("");
        await selectSession(result.sessionId);
      }
    } catch (value) {
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  const sendMessage = async (
    intent: "implement" | "investigate",
  ): Promise<void> => {
    const sessionId = activeId();
    const content = prompt().trim();
    if (!sessionId || !content || activeSession()?.status === "running") return;
    setSubmitting(true);
    setError(null);
    setPrompt("");
    const sendStarted = performance.now();
    sendStartedAt = sendStarted;
    try {
      await client.execute({
        type: "send-message",
        sessionId,
        prompt:
          intent === "investigate"
            ? `${INVESTIGATE_DIRECTIVE}\n\n${content}`
            : content,
        mode: followupMode(),
        reasoningEffort: followupEffort(),
        intent,
      });
      perfLog("send:execute-returned", performance.now() - sendStarted);
    } catch (value) {
      setPrompt(content);
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  // Archiving a session retires its browser tabs for real: the host pages
  // close (the strip × stays for closing tabs one at a time while the
  // session is active), and an unarchive later starts from a clean strip.
  const closeSessionBrowserTabs = async (sessionId: string): Promise<void> => {
    let tabIds: readonly TabId[] = [];
    if (activeId() === sessionId) {
      tabIds = sideTabs().flatMap((tab) => {
        const hostTabId = sideTabHostTabId(tab);
        return hostTabId ? [hostTabId] : [];
      });
      setSideTabs(pinnedSideTabs);
      setActiveSideTabId("patches");
    } else {
      // The session is not shown, so its strip lives only in the persisted
      // record; close the host tabs its entries still name.
      try {
        const saved = await client.sessionTabs(sessionId);
        const known = new Set(browserState().tabs.map(({ id }) => id));
        tabIds = (saved?.tabs ?? []).flatMap((tab) =>
          known.has(tab.tabId as TabId) ? [tab.tabId as TabId] : [],
        );
      } catch {
        return; // background pane state; leave the pages untouched
      }
    }
    for (const tabId of tabIds) {
      void runBrowser({ type: "close-tab", tabId });
    }
    // Archived sessions start from a clean strip after unarchive, so the
    // persisted tabs go too — otherwise a restore would reopen the pages
    // the archive just retired.
    void client.saveSessionTabs(sessionId, null).catch(() => undefined);
  };

  const setSessionArchived = async (
    sessionId: string,
    archived: boolean,
  ): Promise<void> => {
    setError(null);
    try {
      await client.execute({
        type: archived ? "archive-session" : "unarchive-session",
        sessionId,
      });
      // Only after the archive succeeded, so a failed request leaves the
      // session and its pages untouched.
      if (archived) void closeSessionBrowserTabs(sessionId);
    } catch (value) {
      showError(value);
    }
  };

  // Opening a session marks its current outcome as seen: the host copies the
  // row's statusDetail into seenStatusDetail, so the sidebar renders the
  // completed status gray until the next run produces a new description.
  // Fire-and-forget: a failure only means the status stays blue.
  const markSessionSeen = (sessionId: string): void => {
    void client
      .execute({ type: "mark-session-seen", sessionId })
      .catch(() => undefined);
  };

  const renameSession = async (
    sessionId: string,
    title: string,
  ): Promise<void> => {
    setError(null);
    try {
      await client.execute({ type: "rename-session", sessionId, title });
    } catch (value) {
      showError(value);
    }
  };

  // The sidebar sends the full ordered active-session id list (folder
  // groups stay contiguous by construction), so the host's ranks always
  // mirror what the user sees.
  const reorderSessions = async (
    orderedIds: readonly string[],
  ): Promise<void> => {
    setError(null);
    try {
      await client.execute({ type: "reorder-sessions", orderedIds });
    } catch (value) {
      showError(value);
    }
  };

  const implementNext = async (
    index: number,
    task: AgentPlanTask,
  ): Promise<void> => {
    const sessionId = activeId();
    if (!sessionId || activeSession()?.status === "running") return;
    setSubmitting(true);
    setError(null);
    try {
      await client.execute({
        type: "send-message",
        sessionId,
        prompt: implementNextPrompt(index, task),
        mode: followupMode(),
        reasoningEffort: followupEffort(),
        intent: "implement",
      });
    } catch (value) {
      showError(value);
    } finally {
      setSubmitting(false);
    }
  };

  const loadOlder = async (): Promise<void> => {
    const sessionId = activeId();
    const cursor = before();
    if (!sessionId || !cursor || !hasOlder() || loadingOlder()) return;
    setLoadingOlder(true);
    const oldHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await client.loadOlder(sessionId, cursor, 200);
      setMessages((current) => {
        const ids = new Set(current.map(({ id }) => id));
        return [...page.messages.filter(({ id }) => !ids.has(id)), ...current];
      });
      setBefore(page.before);
      setHasOlder(page.hasOlder);
      requestAnimationFrame(() => {
        if (transcript)
          transcript.scrollTop += transcript.scrollHeight - oldHeight;
      });
    } catch (value) {
      showError(value);
    } finally {
      setLoadingOlder(false);
    }
  };

  // If the loaded page fits in the viewport, no scroll event can ever fire,
  // so older pages must be backfilled until the transcript is scrollable.
  createEffect(() => {
    if (!hasOlder() || !before() || loadingOlder() || loadingFeed()) return;
    const element = transcript;
    if (element && element.scrollHeight <= element.clientHeight) {
      void loadOlder();
    }
  });

  void Promise.all([client.providers(), client.sessions()])
    .then(([nextProviders, state]) => {
      bootDebug(
        `agent-renderer sessions:resolved providers=${nextProviders.length} sessions=${state.sessions.length}`,
      );
      setProviders(nextProviders);
      acceptSessions(state);
    })
    .catch(showError);

  onCleanup(() => {
    feedGeneration += 1;
    closeFeed();
    // One last best-effort write of the global strip before the pending
    // timer dies with the renderer. The session record needs no teardown
    // write: intent deltas land as they happen, so a dying renderer has
    // nothing left to say about the session's tabs.
    globalTabsPersister.flush();
    globalTabsPersister.dispose();
    narrowSide.removeEventListener("change", collapseSideWhenNarrow);
  });

  return {
    // agent state
    providers,
    sessions,
    activeId,
    messages,
    before,
    hasOlder,
    loadingFeed,
    loadingOlder,
    prompt,
    setPrompt,
    folder,
    setFolder,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    reasoningEffort,
    setReasoningEffort,
    newMode,
    setNewMode,
    modeDrafts,
    effortDrafts,
    initialMode,
    followupMode,
    followupEffort,
    setFollowupEffort,
    activeSessionModel,
    setMode,
    submitting,
    error,
    setError,
    folderOrder,
    persistFolderOrder,
    collapsedFolders,
    setFolderCollapsed,
    recentFoldersList,
    modelMenuOpen,
    setModelMenuOpen,
    followupMenuOpen,
    setFollowupMenuOpen,
    folderMenuOpen,
    setFolderMenuOpen,
    createOpen,
    setCreateOpen,
    archivedOpen,
    setArchivedOpen,
    selectedProvider,
    selectedModel,
    timeline,
    patches,
    latestUsage,
    activeSession,
    activeSessions,
    archivedSessions,
    activePlan,
    planAfterIndex,
    // browser state
    browserState,
    browserError,
    runBrowser,
    // side pane
    sideCollapsed,
    setSideCollapsed,
    sideTabs,
    activeSideTabId,
    setActiveSideTabId,
    focusSideTab,
    sideActive,
    activeBrowserTab,
    openBrowserSideTab,
    openUrlSideTab,
    closeSideTab,
    // global tabs
    globalTabs,
    activeGlobalTabId,
    setActiveGlobalTabId,
    focusedGlobalTab,
    focusGlobalTab: navigateToGlobalTab,
    openGlobalTab,
    openWhiteboardTab,
    closeGlobalTab,
    // feed plumbing
    transcriptScroll,
    patchScroll,
    setTranscriptElement,
    setPatchListElement,
    transcriptElement,
    patchListElement,
    loadOlder,
    // actions
    selectSession,
    newSession,
    chooseFolder,
    startSession,
    sendMessage,
    implementNext,
    setSessionArchived,
    renameSession,
    reorderSessions,
  };
}

export type AppState = ReturnType<typeof createAppState>;
