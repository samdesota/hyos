import type {
  BrowserState,
  BrowserTabState,
  TabId,
} from "../../capabilities/browser.js";
import type {
  AgentSessionTab,
  AgentSessionTabs,
} from "../../capabilities/agent.js";

/**
 * Model for the session side pane's tabs. The pane hosts one tab per
 * presentation surface — the patch feed, and one browser tab per host
 * browser tab. Kinds form a closed union so the strip's labels and glyphs
 * stay exhaustive: adding a kind forces a descriptor entry.
 */
export type SideTab =
  | Readonly<{ id: string; kind: "patches" }>
  | Readonly<{ id: string; kind: "browser"; tabId: TabId }>;

export type SideTabKind = SideTab["kind"];

/** Label and strip glyph for every tab kind, keyed exhaustively by kind. */
export const sideTabDescriptors: Readonly<
  Record<SideTabKind, Readonly<{ label: string; icon: string }>>
> = {
  patches: { label: "Patches", icon: "±" },
  browser: { label: "Browser", icon: "◉" },
};

/** Tabs that are always present in the strip and cannot be closed. */
export const pinnedSideTabs: readonly SideTab[] = [
  { id: "patches", kind: "patches" },
];

export function isPinnedSideTab(tab: SideTab): boolean {
  return pinnedSideTabs.some(({ id }) => id === tab.id);
}

/**
 * The tab the pane shows: the active tab while it exists, else the first
 * pinned tab — so a stale id (a dynamic tab closed, or dropped by a module
 * hot reload) can never blank the pane.
 */
export function activeSideTab(
  tabs: readonly SideTab[],
  activeId: string | null,
): SideTab | null {
  return (
    tabs.find((tab) => tab.id === activeId) ??
    tabs.find((tab) => isPinnedSideTab(tab)) ??
    null
  );
}

/**
 * The first host browser tab the strip does not already show — the one a
 * `+` click focuses instead of creating a duplicate. Null once every host
 * tab is already in the strip.
 */
export function unadoptedHostTab(
  state: BrowserState,
  tabs: readonly SideTab[],
): BrowserTabState | null {
  const adopted = new Set(
    tabs.flatMap((tab) => (tab.kind === "browser" ? [tab.tabId] : [])),
  );
  return state.tabs.find(({ id }) => !adopted.has(id)) ?? null;
}

/**
 * Drop browser tabs the published host state no longer knows — closed, or
 * lost to a browser.main hot reload, which recreates the host and its tab
 * ids. Returns the input untouched when nothing is stale, so the frequent
 * state publishes never churn the list.
 */
export function reconcileSideTabs(
  tabs: readonly SideTab[],
  state: BrowserState,
): readonly SideTab[] {
  const known = new Set(state.tabs.map(({ id }) => id));
  const kept = tabs.filter(
    (tab) => tab.kind !== "browser" || known.has(tab.tabId),
  );
  return kept.length === tabs.length ? tabs : kept;
}

/**
 * A session's private side-pane state: the strip's tabs and the focused tab
 * id. Host browser tabs are global, but each session's strip only shows the
 * host tabs it adopted, so switching sessions swaps the pane — releasing the
 * outgoing session's presentations — while its pages keep running in the
 * host for the session to re-adopt later.
 */
export type SideTabScope = Readonly<{
  tabs: readonly SideTab[];
  activeId: string | null;
}>;

/** Pane scope key while no session exists yet (the new-session view). */
export const NEW_SESSION_SCOPE_KEY = "~new-session";

export function sideTabScopeKey(sessionId: string | null): string {
  return sessionId ?? NEW_SESSION_SCOPE_KEY;
}

/** The strip a session starts with: only the pinned Patches tab. */
export function initialSideTabScope(): SideTabScope {
  return { tabs: pinnedSideTabs, activeId: "patches" };
}

/** The host browser tab ids a scope's strip adopted. */
export function scopeBrowserTabIds(scope: SideTabScope): TabId[] {
  return scope.tabs.flatMap((tab) =>
    tab.kind === "browser" ? [tab.tabId] : [],
  );
}

/**
 * The session's pane as the generic per-session shape the agent store
 * persists: one browser entry per adopted host tab, in strip order, with the
 * focused entry's index — or -1 when the pinned tab (or nothing browser-y)
 * was focused, since the pinned tabs are implicit on restore. Host tab ids
 * are session-agnostic runtime ids, so only what outlives them — url and
 * title — is kept. Null when the scope shows no browser tabs: the store
 * decodes an empty list to null anyway, so saving nothing avoids churn.
 */
export function snapshotSessionTabs(
  scope: SideTabScope,
  state: BrowserState,
): AgentSessionTabs | null {
  const byTabId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs: AgentSessionTab[] = [];
  const indices = new Map<TabId, number>();
  for (const tab of scope.tabs) {
    if (tab.kind !== "browser") continue;
    const hostTab = byTabId.get(tab.tabId);
    if (!hostTab) continue; // stale; reconciliation drops it anyway
    indices.set(tab.tabId, tabs.length);
    tabs.push({ kind: "browser", url: hostTab.url, title: hostTab.title });
  }
  if (tabs.length === 0) return null;
  const focused = scope.tabs.find(({ id }) => id === scope.activeId);
  return {
    tabs,
    activeIndex:
      focused && focused.kind === "browser"
        ? (indices.get(focused.tabId) ?? -1)
        : -1,
  };
}

/**
 * One restored browser tab resolved against the live host state: adopt an
 * existing host tab showing the same url, or open a fresh one.
 */
export type SessionTabPlacement =
  | Readonly<{ kind: "reuse"; tabId: TabId; url: string }>
  | Readonly<{ kind: "create"; url: string }>;

export type SessionTabsRestore = Readonly<{
  /** One placement per saved browser tab, in saved order. */
  placements: readonly SessionTabPlacement[];
  /** The placement to focus, or -1 → the caller falls back to the pinned tab. */
  activeIndex: number;
}>;

/**
 * Resolve a session's saved tabs against the live host state. Host tabs are
 * global and keep running across scope swaps, so a saved tab reuses the
 * first host tab not already claimed by an earlier entry that shows its url
 * — restoring after a restart must not duplicate pages that are still open —
 * and only urls with no live match open fresh. A focus that cannot be
 * honored — no saved tabs, or an index out of range — restores as -1, letting
 * the pane fall back to its pinned tab instead of inventing a selection.
 */
export function restoreSessionTabs(
  saved: AgentSessionTabs | null,
  state: BrowserState,
): SessionTabsRestore {
  const savedTabs = saved?.tabs ?? [];
  if (savedTabs.length === 0) return { placements: [], activeIndex: -1 };
  const claimed = new Set<TabId>();
  const placements = savedTabs.map((tab): SessionTabPlacement => {
    const hostTab = state.tabs.find(
      ({ id, url }) => !claimed.has(id) && url === tab.url,
    );
    if (!hostTab) return { kind: "create", url: tab.url };
    claimed.add(hostTab.id);
    return { kind: "reuse", tabId: hostTab.id, url: tab.url };
  });
  const index = saved?.activeIndex;
  return {
    placements,
    activeIndex:
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < placements.length
        ? index
        : -1,
  };
}

/**
 * The host tab a `create-tab` call added: the one absent from the state
 * before the call. Null when the call returned nothing new (it failed, or
 * the new tab could not be told apart from an external one).
 */
export function createdHostTabId(
  before: BrowserState,
  after: BrowserState,
): TabId | null {
  const known = new Set(before.tabs.map(({ id }) => id));
  return after.tabs.find(({ id }) => !known.has(id))?.id ?? null;
}

/**
 * Adopt a freshly created host browser tab in the session strip: appended at
 * the end and idempotent — a tab the strip already shows (or an external
 * writer beat us to) is left in place rather than duplicated.
 */
export function adoptCreatedSideTab(
  tabs: readonly SideTab[],
  tabId: TabId,
): readonly SideTab[] {
  return tabs.some((tab) => tab.kind === "browser" && tab.tabId === tabId)
    ? tabs
    : [...tabs, { id: tabId, kind: "browser", tabId }];
}

/**
 * The side tab to focus after closing one: the next tab in strip order, else
 * the previous one — mirroring the browser host's fallback activation. Null
 * when the closed tab was unknown or nothing remains.
 */
export function neighborSideTabId(
  tabs: readonly SideTab[],
  closedId: string,
): string | null {
  const index = tabs.findIndex(({ id }) => id === closedId);
  if (index === -1) return null;
  const remaining = tabs.filter(({ id }) => id !== closedId);
  return remaining[index]?.id ?? remaining[index - 1]?.id ?? null;
}

/** Strip label: the pinned descriptor label, or the presented page title. */
export function sideTabLabel(tab: SideTab, state: BrowserState): string {
  if (tab.kind !== "browser") return sideTabDescriptors[tab.kind].label;
  return (
    state.tabs.find(({ id }) => id === tab.tabId)?.title.trim() ||
    sideTabDescriptors.browser.label
  );
}
