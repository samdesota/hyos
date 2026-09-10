import type {
  BrowserState,
  BrowserTabState,
  TabId,
} from "../../capabilities/browser.js";
import { createdHostTabId } from "./side-pane.js";

export { createdHostTabId };

/**
 * Model for the app-level global tab strip in the sidebar. A global tab is a
 * presentation surface owned by the app rather than any session; kinds form
 * an open union so new surfaces can join without reshaping the strip — the
 * browser kind reuses the host's already-global browser tabs, while a
 * whiteboard tab is only a view onto a persisted board (boardId), so closing
 * the tab never destroys the board.
 */
export type GlobalTab =
  | Readonly<{ id: string; kind: "browser"; tabId: TabId }>
  | Readonly<{ id: string; kind: "whiteboard"; boardId: string }>;

/** Glyph and fallback label per tab kind, keyed exhaustively by kind. */
export const globalTabDescriptors: Readonly<
  Record<GlobalTab["kind"], Readonly<{ label: string; icon: string }>>
> = {
  browser: { label: "Browser", icon: "◉" },
  whiteboard: { label: "Whiteboard", icon: "▦" },
};

/**
 * The tab the strip shows: the active tab while it exists, else null — a
 * stale id (a dynamic tab closed, or dropped by reconciliation) must never
 * invent a selection, unlike the session pane which has a pinned fallback.
 */
export function activeGlobalTab(
  tabs: readonly GlobalTab[],
  activeId: string | null,
): GlobalTab | null {
  return tabs.find((tab) => tab.id === activeId) ?? null;
}

/** Strip label: the presented page title, or the kind's fallback label. */
export function globalTabLabel(tab: GlobalTab, state: BrowserState): string {
  const fallback = globalTabDescriptors[tab.kind].label;
  if (tab.kind !== "browser") return fallback;
  return (
    state.tabs.find(({ id }) => id === tab.tabId)?.title.trim() ||
    globalTabDescriptors.browser.label
  );
}

/**
 * The first host browser tab the strip does not already show — the one a
 * `+` click focuses instead of creating a duplicate. Null once every host
 * tab is already in the strip.
 */
export function unadoptedGlobalHostTab(
  state: BrowserState,
  tabs: readonly GlobalTab[],
): BrowserTabState | null {
  const adopted = new Set(
    tabs.flatMap((tab) => (tab.kind === "browser" ? [tab.tabId] : [])),
  );
  return state.tabs.find(({ id }) => !adopted.has(id)) ?? null;
}

/**
 * Drop tabs the published host state no longer knows — closed, or lost to a
 * browser.main hot reload, which recreates the host and its tab ids. Returns
 * the input untouched when nothing is stale, so frequent publishes never
 * churn the strip.
 */
export function reconcileGlobalTabs(
  tabs: readonly GlobalTab[],
  state: BrowserState,
): readonly GlobalTab[] {
  const known = new Set(state.tabs.map(({ id }) => id));
  const kept = tabs.filter(
    (tab) => tab.kind !== "browser" || known.has(tab.tabId),
  );
  return kept.length === tabs.length ? tabs : kept;
}

/**
 * The tab to focus after closing one: the next tab in strip order, else the
 * previous one — mirroring the browser host's fallback activation. Null when
 * the closed tab was unknown or nothing remains.
 */
export function neighborGlobalTabId(
  tabs: readonly GlobalTab[],
  closedId: string,
): string | null {
  const index = tabs.findIndex(({ id }) => id === closedId);
  if (index === -1) return null;
  const remaining = tabs.filter(({ id }) => id !== closedId);
  return remaining[index]?.id ?? remaining[index - 1]?.id ?? null;
}

/** The global strip as the shape persisted across renderer reloads. */
export type GlobalTabsSnapshot = Readonly<{
  tabs: readonly GlobalTabsSnapshotEntry[];
  activeIndex: number;
}>;

/** One persisted browser entry — the mutable shape the snapshot builds. */
type GlobalTabsSnapshotEntry = { kind: "browser"; url: string; title: string };

/**
 * The strip as a persistence snapshot: one browser entry per adopted host
 * tab, in strip order, with the focused entry's index — or -1 when nothing
 * browser-y was focused. Host tab ids are runtime ids, so only what outlives
 * them — url and title — is kept. Null when the strip is empty, so restoring
 * skips the write instead of persisting nothing.
 */
export function snapshotGlobalTabs(
  scope: Readonly<{ tabs: readonly GlobalTab[]; activeId: string | null }>,
  state: BrowserState,
): GlobalTabsSnapshot | null {
  const byTabId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs: GlobalTabsSnapshotEntry[] = [];
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

/** One restored browser tab resolved against the live host state. */
export type GlobalTabPlacement =
  | Readonly<{ kind: "reuse"; tabId: TabId; url: string }>
  | Readonly<{ kind: "create"; url: string }>;

export type GlobalTabsRestore = Readonly<{
  /** One placement per saved browser tab, in saved order. */
  placements: readonly GlobalTabPlacement[];
  /** The placement to focus, or -1 → nothing is focused on restore. */
  activeIndex: number;
}>;

/**
 * Resolve a saved strip against the live host state. Host tabs are global
 * and keep running across reloads, so a saved tab reuses the first host tab
 * not already claimed by an earlier entry that shows its url — restoring
 * must not duplicate pages that are still open — and only urls with no live
 * match open fresh. A focus that cannot be honored restores as -1.
 */
export function restoreGlobalTabs(
  saved: GlobalTabsSnapshot | null,
  state: BrowserState,
): GlobalTabsRestore {
  const savedTabs = saved?.tabs ?? [];
  if (savedTabs.length === 0) return { placements: [], activeIndex: -1 };
  const claimed = new Set<TabId>();
  const placements = savedTabs.map((tab): GlobalTabPlacement => {
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
