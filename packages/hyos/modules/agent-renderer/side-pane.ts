import type {
  BrowserState,
  BrowserTabState,
  TabId,
} from "../../capabilities/browser.js";

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
