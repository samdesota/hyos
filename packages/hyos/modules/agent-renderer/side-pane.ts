import type {
  BrowserState,
  BrowserTabState,
  TabId,
} from "../../capabilities/browser.js";
import type { AgentSessionTabs } from "../../capabilities/agent.js";

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
 * Identity-safe form of a tab url: origin + path plus every query param
 * except the per-navigation Cloudflare-challenge tokens (`__cf_chl_*`),
 * which change on every challenged navigation. Two urls equal under this
 * normalization are the same page even when one is mid-challenge.
 */
export function normalizeTabUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.forEach((value, key) => {
      if (key.startsWith("__cf_chl")) parsed.searchParams.delete(key);
    });
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return url;
  }
}

/**
 * Cross-projection create ledger for session restore. A `create-tab` is
 * async, and a projection re-run (or another session's projection) can
 * start while one is in flight; without a ledger each runner sees "no live
 * tab for this url" and opens the page again — the duplicate burst. The
 * ledger makes creation single-flight per normalized url and remembers the
 * tab each create produced, so a later projection adopts the tab we already
 * opened instead of creating its own copy.
 */
/** Whether two urls name the same page once challenge tokens are stripped. */
export const urlMatches = (a: string, b: string): boolean =>
  normalizeTabUrl(a) === normalizeTabUrl(b);

export class TabCreateLedger {
  private readonly inFlight = new Map<string, Promise<TabId | null>>();
  private readonly created = new Map<string, TabId>();

  /**
   * The tab this ledger already produced for the url, if any. Cleared
   * externally when the host tab is closed (a later create must then open
   * the page fresh).
   */
  createdFor(url: string): TabId | null {
    return this.created.get(normalizeTabUrl(url)) ?? null;
  }

  /** Forget a tab the ledger created — its host tab is gone. */
  forget(tabId: TabId): void {
    for (const [key, created] of this.created) {
      if (created === tabId) this.created.delete(key);
    }
  }

  /**
   * Run a create for the url at most once at a time: a concurrent call for
   * the same page joins the in-flight promise instead of issuing its own
   * `create-tab`, and the produced tab id is remembered for later lookups.
   */
  createOnce(
    url: string,
    create: () => Promise<TabId | null>,
  ): Promise<TabId | null> {
    const key = normalizeTabUrl(url);
    const running = this.inFlight.get(key);
    if (running) return running;
    const promise = create()
      .then((tabId) => {
        if (tabId) this.created.set(key, tabId);
        return tabId;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }
}

/**
 * One restored browser tab resolved against the live host state: adopt the
 * persisted host tab whenever its id is still alive (ids are UUIDs, unique
 * across host restarts, so a live id is the recorded page's tab whatever url
 * it shows now), else reuse any unclaimed live tab on the exact recorded
 * url, else open fresh.
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
 * Resolve a session's saved tabs against the live host state. Each record
 * entry persists a {tabId, url} pair: the named host tab is adopted whenever
 * it is still alive — ids are UUIDs, so a live id is the same tab whatever
 * url it now shows — while a stale id (host restart) falls back to the first
 * unclaimed live tab on the recorded url, and only urls with no live match
 * open fresh. Host tabs are global and keep running while other sessions are
 * shown, so restoring after a restart must not duplicate pages still open. A
 * focus that cannot be honored — no saved tabs, or an index out of range —
 * restores as -1, letting the pane fall back to its pinned tab instead of
 * inventing a selection.
 */
export function restoreSessionTabs(
  saved: AgentSessionTabs | null,
  state: BrowserState,
): SessionTabsRestore {
  const savedTabs = saved?.tabs ?? [];
  if (savedTabs.length === 0) return { placements: [], activeIndex: -1 };
  const claimed = new Set<TabId>();
  const placements = savedTabs.map((tab): SessionTabPlacement => {
    const byId = state.tabs.find(
      ({ id }) => !claimed.has(id) && id === tab.tabId,
    );
    const hostTab =
      byId ??
      state.tabs.find(
        ({ id, url }) => !claimed.has(id) && urlMatches(url, tab.url),
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
