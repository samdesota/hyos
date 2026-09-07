import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type {
  AgentMessage,
  AgentMode,
  AgentPlanTask,
  AgentReasoningEffort,
  AgentMessageChange,
  AgentProviderSummary,
  AgentSessionSummary,
  AgentSessionTabs,
} from "../../capabilities/agent.js";
import type {
  BrowserCommand,
  BrowserState,
  TabId,
} from "../../capabilities/browser.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { AgentClient, AgentMessageFeed } from "./client.js";
import { createAutoScrollController } from "./auto-scroll.js";
import { perfLog, perfNow, timeAsync } from "./perf-time.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  activeSideTab,
  createdHostTabId,
  initialSideTabScope,
  isPinnedSideTab,
  neighborSideTabId,
  pinnedSideTabs,
  reconcileSideTabs,
  restoreSessionTabs,
  scopeBrowserTabIds,
  sideTabScopeKey,
  snapshotSessionTabs,
  unadoptedHostTab,
  type SessionTabPlacement,
  type SideTab,
  type SideTabScope,
} from "./side-pane.js";
import {
  activeGlobalTab,
  neighborGlobalTabId,
  reconcileGlobalTabs,
  unadoptedGlobalHostTab,
  type GlobalTab,
} from "./global-tabs.js";
import { createSessionTabsPersister } from "./session-tabs.js";
import { selectedMode } from "./mode-selection.js";
import {
  collapseWorkRuns,
  implementNextPrompt,
  loadFolderOrder,
  orderedFolders,
  partitionSessions,
  patchEntries,
  planPanelIndex,
  recentFolders,
  saveFolderOrder,
  timelineEntries,
} from "./sessions-model.js";
import { sessionFromHash, syncHashToSession } from "./session-route.js";

export type AppStateProps = Readonly<{
  client: AgentClient;
  browserClient: BrowserClient;
}>;

/**
 * Shared app-wide state and actions: agent providers/sessions, the active
 * session's message feed, browser host state, and the global tab strip.
 * Created once inside the app root (its effects and cleanup register
 * against the owning component) and threaded down to route components.
 */
export function createAppState({ client, browserClient }: AppStateProps) {
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
  const [folderOrder, setFolderOrder] = createSignal<readonly string[] | null>(
    loadFolderOrder(),
  );
  const persistFolderOrder = (order: readonly string[]): void => {
    setFolderOrder(order);
    saveFolderOrder(order);
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
      setActiveGlobalTabId(`global-${adoptable.id}`);
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
    setActiveGlobalTabId(`global-${tabId}`);
  };
  const closeGlobalTab = (tab: GlobalTab): void => {
    const neighborId = neighborGlobalTabId(globalTabs(), tab.id);
    setGlobalTabs((tabs) => tabs.filter(({ id }) => id !== tab.id));
    if (activeGlobalTabId() === tab.id) setActiveGlobalTabId(neighborId);
    // Closing retires the page for real: the host tab goes with it, so the
    // strip (and any session pane showing it) reconciles it away.
    if (tab.kind === "browser") {
      void runBrowser({ type: "close-tab", tabId: tab.tabId });
    }
  };

  // Persisted pane state: the active session's strip is snapshotted into
  // the agent sessions DB so a restart or a renderer reload brings its
  // browser tabs back. Host publishes arrive for every loading tick, so
  // the write is debounced and the snapshot is taken when it fires — never
  // when scheduled — coalescing a burst into one fresh write under the
  // session that is active at that moment.
  const tabsPersister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => {
      const sessionId = activeId();
      if (!sessionId) return null;
      return {
        sessionId,
        tabs: snapshotSessionTabs(
          { tabs: sideTabs(), activeId: activeSideTabId() },
          browserState(),
        ),
      };
    },
    save: ({ sessionId, tabs }) => client.saveSessionTabs(sessionId, tabs),
  });

  // Each session owns its strip: switching sessions stashes the outgoing
  // strip and adopts the incoming one, so browser tabs are private to a
  // session while their pages keep running in the host in the background.
  const sideTabScopes = new Map<string, SideTabScope>();
  const swapSideTabScope = (incomingId: string | null): void => {
    // Flush before stashing: the outgoing session's latest strip — including
    // focus changes that never triggered a publish — is persisted under its
    // own id before the pane moves on.
    tabsPersister.flush();
    sideTabScopes.set(sideTabScopeKey(activeId()), {
      tabs: sideTabs(),
      activeId: activeSideTabId(),
    });
    const stashed = sideTabScopes.get(sideTabScopeKey(incomingId));
    sideTabScopes.delete(sideTabScopeKey(incomingId));
    // Host tabs may have closed while this session was inactive; dropping
    // them here keeps a re-adopted strip from showing dead tabs.
    const tabs = reconcileSideTabs(
      stashed?.tabs ?? initialSideTabScope().tabs,
      browserState(),
    );
    setSideTabs(tabs);
    setActiveSideTabId(stashed?.activeId ?? "patches");
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
    return tab?.kind === "browser" ? tab : null;
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
      console.log(
        `[DEBUG-boot-7f2c] agent-renderer browser-state count=${browserPublishCount} tabs=${next.tabs.length}`,
      );
    setBrowserState(next);
    setSideTabs((tabs) => reconcileSideTabs(tabs, next));
    setGlobalTabs((tabs) => reconcileGlobalTabs(tabs, next));
    // Every accepted publish may have changed what the pane shows (tab
    // titles drift as pages load, even when the strip does not); the
    // persister coalesces that churn into one debounced write.
    tabsPersister.request();
  };
  const unsubscribeBrowser = browserClient.subscribe(acceptBrowserState);
  onCleanup(() => unsubscribeBrowser());
  const bootBrowserSnapshot: Promise<void> = browserClient
    .execute({ type: "snapshot" })
    .then((state) => {
      console.log("[DEBUG-boot-7f2c] agent-renderer browser-snapshot:resolved");
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
    if (tab?.kind !== "browser" || focusedGlobalTab()) return;
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
        { id: adoptable.id, kind: "browser", tabId: adoptable.id },
      ]);
      setActiveSideTabId(adoptable.id);
      setSideCollapsed(false);
      return;
    }
    const before = browserState();
    void runBrowser({ type: "create-tab" }).then((next) => {
      const tabId = next ? createdHostTabId(before, next) : null;
      if (!tabId) return;
      setSideTabs((tabs) =>
        tabs.some((tab) => tab.kind === "browser" && tab.tabId === tabId)
          ? tabs
          : [...tabs, { id: tabId, kind: "browser", tabId }],
      );
      setActiveSideTabId(tabId);
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
    if (tab.kind === "browser") {
      void runBrowser({ type: "close-tab", tabId: tab.tabId });
    }
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
    setSessions(state.sessions);
  };

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

  const applyMessageChange = (change: AgentMessageChange): void => {
    setMessages((current) => {
      if (change.type === "message-created") {
        if (current.some(({ id }) => id === change.message.id)) return current;
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
        const live = browserState().tabs.find(
          ({ id, url }) => !claimed.has(id) && url === placement.url,
        );
        if (live) {
          tabId = live.id;
        } else {
          const before = browserState();
          const next = await runBrowser({
            type: "create-tab",
            url: placement.url,
          });
          tabId = next ? createdHostTabId(before, next) : null;
          if (tabId) created.push(tabId);
        }
      }
      if (tabId) claimed.add(tabId);
      if (isStale()) {
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
  // call; the strip simply reflects the session's persisted state.
  const adoptResolvedTabs = (
    tabIds: readonly (TabId | null)[],
    focusedId: TabId | null,
  ): void => {
    setSideTabs((tabs) => {
      const shown = new Set(
        tabs.flatMap((tab) => (tab.kind === "browser" ? [tab.tabId] : [])),
      );
      const additions = tabIds
        .filter((tabId): tabId is TabId => tabId !== null && !shown.has(tabId))
        .map((tabId) => ({ id: tabId, kind: "browser" as const, tabId }));
      return additions.length === 0 ? tabs : [...tabs, ...additions];
    });
    if (focusedId) setActiveSideTabId(focusedId);
  };

  // Re-open a session's persisted browser tabs on its first open: host tabs
  // still showing a saved url are re-adopted in place, urls with no live tab
  // are opened fresh in saved order, and the saved focus is re-applied.
  // `generation` abandons the restore the moment another selection wins —
  // the strip it was building belongs to a session that is no longer shown.
  let stripRestoreInFlight = false;
  const restoreSavedTabs = async (
    sessionId: string,
    generation: number,
  ): Promise<void> => {
    let saved: AgentSessionTabs | null = null;
    try {
      saved = await timeAsync(
        `session-open:tab-restore-fetch(${sessionId})`,
        () => client.sessionTabs(sessionId),
      );
    } catch {
      // Background pane state: a failed load just leaves the strip as-is.
      return;
    }
    // A renderer reload keeps the host's tabs alive, but the boot snapshot
    // revealing them may still be in flight; restoring against it keeps a
    // fast reopen from opening duplicates for tabs that never went away.
    await bootBrowserSnapshot;
    if (generation !== feedGeneration || !saved) return;
    stripRestoreInFlight = true;
    try {
      const { placements, activeIndex } = restoreSessionTabs(
        saved,
        browserState(),
      );
      const tabIds = await resolvePlacements(
        placements,
        () => generation !== feedGeneration,
      );
      if (generation !== feedGeneration) return;
      adoptResolvedTabs(
        tabIds,
        activeIndex >= 0 ? (tabIds[activeIndex] ?? null) : null,
      );
    } finally {
      stripRestoreInFlight = false;
    }
  };

  // Subscription-driven strip reconciliation: the session's persisted strip
  // changed (the agent's browser_open_tab wrote it in step 2, another
  // renderer wrote it, …). When it is the active session, adopt the tabs it
  // names and apply its focus. Appending only: tabs the strip already shows
  // are left in place, and a tab the user just closed — whose removal is
  // still sitting in the persister's debounce — is not resurrected by a
  // stale event. Unchanged writes never fire (the store suppresses them),
  // so this runs only on real strip changes, and the echo write the apply
  // itself triggers is swallowed there too.
  let stripApplying = false;
  const applySessionStrip = async (
    sessionId: string,
    saved: AgentSessionTabs | null,
  ): Promise<void> => {
    if (sessionId !== activeId() || stripRestoreInFlight || stripApplying)
      return;
    await bootBrowserSnapshot;
    if (sessionId !== activeId() || stripRestoreInFlight) return;
    stripApplying = true;
    try {
      const { placements, activeIndex } = restoreSessionTabs(
        saved,
        browserState(),
      );
      const tabIds = await resolvePlacements(placements, () => {
        if (sessionId !== activeId() || stripRestoreInFlight) return true;
        return false;
      });
      if (sessionId !== activeId()) return;
      adoptResolvedTabs(
        tabIds,
        activeIndex >= 0 ? (tabIds[activeIndex] ?? null) : null,
      );
    } finally {
      stripApplying = false;
    }
  };
  const unsubscribeSessionTabs = client.subscribeSessionTabs(
    ({ sessionId, tabs }) => {
      void applySessionStrip(sessionId, tabs);
    },
  );
  onCleanup(() => unsubscribeSessionTabs());

  const selectSession = async (sessionId: string): Promise<void> => {
    const selectStart = perfNow();
    let feedOpenDone = 0;
    const generation = ++feedGeneration;
    closeFeed();
    // Only a session's first open restores its persisted tabs: an in-memory
    // stash is fresher than the DB, and re-selecting the active session
    // must not resurrect tabs the user has closed since.
    const firstOpen =
      !sideTabScopes.has(sideTabScopeKey(sessionId)) &&
      sessionId !== activeId();
    swapSideTabScope(sessionId);
    setActiveId(sessionId);
    syncHashToSession(sessionId);
    setPrompt("");
    setMessages([]);
    setBefore(null);
    setHasOlder(false);
    setLoadingFeed(true);
    setError(null);
    transcriptScroll.reset();
    patchScroll.reset();
    if (firstOpen)
      void timeAsync(`session-open:tab-restore(${sessionId})`, () =>
        restoreSavedTabs(sessionId, generation),
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
    swapSideTabScope(null);
    setActiveId(null);
    syncHashToSession(null);
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

  const startSession = async (): Promise<void> => {
    if (!prompt().trim() || !folder() || !providerId() || !modelId()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.execute({
        type: "start-session",
        prompt: prompt().trim(),
        folder: folder(),
        providerId: providerId(),
        modelId: modelId(),
        reasoningEffort: reasoningEffort(),
        mode: initialMode(),
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

  const INVESTIGATE_DIRECTIVE =
    "[Investigate only. Do not modify any files; use read-only commands, unless a reversible test is genuinely needed.]";

  const sendMessage = async (
    intent: "implement" | "investigate",
  ): Promise<void> => {
    const sessionId = activeId();
    const content = prompt().trim();
    if (!sessionId || !content || activeSession()?.status === "running") return;
    setSubmitting(true);
    setError(null);
    setPrompt("");
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
  const closeSessionBrowserTabs = (sessionId: string): void => {
    const active = activeId() === sessionId;
    const scope = active
      ? { tabs: sideTabs(), activeId: activeSideTabId() }
      : sideTabScopes.get(sideTabScopeKey(sessionId));
    sideTabScopes.delete(sideTabScopeKey(sessionId));
    if (!scope) return;
    if (active) {
      setSideTabs(pinnedSideTabs);
      setActiveSideTabId("patches");
    }
    for (const tabId of scopeBrowserTabIds(scope)) {
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
      if (archived) closeSessionBrowserTabs(sessionId);
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
      console.log(
        `[DEBUG-boot-7f2c] agent-renderer sessions:resolved providers=${nextProviders.length} sessions=${state.sessions.length}`,
      );
      setProviders(nextProviders);
      acceptSessions(state);
      const routedId = sessionFromHash();
      if (routedId && state.sessions.some(({ id }) => id === routedId)) {
        void selectSession(routedId);
      }
    })
    .catch(showError);

  onCleanup(() => {
    feedGeneration += 1;
    closeFeed();
    // A teardown (window close, hot reload) gets one last best-effort write
    // of the active session's pane before the pending timer dies with it.
    tabsPersister.flush();
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
    recentFoldersList,
    modelMenuOpen,
    setModelMenuOpen,
    followupMenuOpen,
    setFollowupMenuOpen,
    folderMenuOpen,
    setFolderMenuOpen,
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
    sideActive,
    activeBrowserTab,
    openBrowserSideTab,
    closeSideTab,
    // global tabs
    globalTabs,
    activeGlobalTabId,
    setActiveGlobalTabId,
    focusedGlobalTab,
    openGlobalTab,
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
  };
}

export type AppState = ReturnType<typeof createAppState>;
