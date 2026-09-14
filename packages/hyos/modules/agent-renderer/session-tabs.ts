import type {
  AgentSessionTab,
  AgentSessionTabs,
} from "../../capabilities/agent.js";
import { tabsDebug } from "./perf-time.js";

/**
 * Intent-delta persistence for a session's side-pane tabs. The persisted
 * record is the only durable truth; these calls never snapshot the pane.
 * Each delta loads the record fresh, composes the user's intent onto it,
 * and writes the result — so writes only ever happen when the user (or an
 * agent) opens, closes, or focuses a tab, never as a side effect of host
 * publishes, scope swaps, or teardown. Failures are swallowed: this is
 * background pane state, not user data.
 */
export function createSessionTabsRecorder(
  options: Readonly<{
    load: (sessionId: string) => Promise<AgentSessionTabs | null>;
    save: (sessionId: string, tabs: AgentSessionTabs | null) => Promise<void>;
    /**
     * Browser entries the pane currently shows for `sessionId`. A delta
     * composes onto the loaded record merged with what is on screen, so an
     * empty record this renderer did not cause — a legacy wipe, a writer we
     * never restored from — cannot erase visible tabs from durability.
     * Visible entries heal stale record ids by url and append new ones.
     */
    visibleTabs: (sessionId: string) => readonly AgentSessionTab[];
  }>,
): Readonly<{
  opened(sessionId: string, tabId: string, url: string): void;
  closed(sessionId: string, tabId: string): void;
  focused(sessionId: string, tabId: string): void;
  /**
   * Bind record entries to the host tab ids a projection resolved: one
   * resolved id per record entry, in record order (null = that entry's tab
   * could not be resolved). Only writes when an id actually changed.
   */
  resolved(sessionId: string, tabIds: readonly (string | null)[]): void;
}> {
  // One load-mutate-save chain per session, so concurrent deltas compose
  // in order instead of racing on the same row.
  const chains = new Map<string, Promise<void>>();

  const describe = (sessionId: string, tabs: AgentSessionTabs | null): string =>
    `session=${sessionId} tabs=${tabs?.tabs.length ?? 0} focus=${tabs?.activeIndex}`;

  const update = (
    sessionId: string,
    mutate: (base: AgentSessionTabs) => AgentSessionTabs | null,
    label: string,
  ): void => {
    const run = async (): Promise<void> => {
      let saved: AgentSessionTabs | null = null;
      try {
        saved = await options.load(sessionId);
      } catch (value) {
        tabsDebug(`record: load failed — ${label} ${String(value)}`);
        return;
      }
      // Transitional merge: the on-screen tabs are part of the base a delta
      // composes onto, so durability can never fall behind what is shown.
      let tabs: AgentSessionTab[] = [...(saved?.tabs ?? [])];
      let activeIndex = saved?.activeIndex ?? -1;
      for (const entry of options.visibleTabs(sessionId)) {
        if (tabs.some((tab) => tab.tabId === entry.tabId)) continue;
        const stale = tabs.findIndex((tab) => tab.url === entry.url);
        if (stale !== -1) tabs[stale] = entry;
        else tabs = [...tabs, entry];
      }
      // The merge itself can repair durability (a visible tab healing a
      // stale recorded id): even a no-op delta then writes the repaired
      // record, so the next projection resolves by id instead of re-creating.
      const merged = { tabs, activeIndex };
      const mergedChanged =
        JSON.stringify(merged) !==
        JSON.stringify(saved ?? { tabs: [], activeIndex: -1 });
      const mutated = mutate(merged);
      // An emptied strip clears the row; a no-op delta writes nothing (the
      // store also suppresses unchanged writes, so our own writes echo back
      // as nothing rather than as strip events to fight).
      const next =
        mutated ?? (mergedChanged && tabs.length > 0 ? merged : null);
      if (!next) return;
      const toSave = next.tabs.length === 0 ? null : next;
      try {
        await options.save(sessionId, toSave);
        tabsDebug(`record: SAVED ${label} (${describe(sessionId, toSave)})`);
      } catch (value) {
        tabsDebug(`record: save failed — ${label} ${String(value)}`);
      }
    };
    const chained = (chains.get(sessionId) ?? Promise.resolve())
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        if (chains.get(sessionId) === chained) chains.delete(sessionId);
      });
    chains.set(sessionId, chained);
  };

  return {
    opened(sessionId, tabId, url) {
      update(
        sessionId,
        (base) => {
          if (base.tabs.some((tab) => tab.tabId === tabId)) return null;
          const tabs = [...base.tabs, { kind: "browser" as const, tabId, url }];
          // The opened page is the point of the click, so it takes focus.
          return { tabs, activeIndex: tabs.length - 1 };
        },
        `opened ${url}`,
      );
    },
    closed(sessionId, tabId) {
      update(
        sessionId,
        (base) => {
          const index = base.tabs.findIndex((tab) => tab.tabId === tabId);
          if (index === -1) return null;
          const tabs = base.tabs.filter((tab) => tab.tabId !== tabId);
          if (tabs.length === 0) return { tabs: [], activeIndex: -1 };
          // The focus falls to the next tab in strip order, mirroring the
          // pane's own close fallback; an out-of-range index reads as -1.
          const activeIndex =
            base.activeIndex === index
              ? Math.min(index, tabs.length - 1)
              : base.activeIndex > index
                ? base.activeIndex - 1
                : base.activeIndex;
          return { tabs, activeIndex };
        },
        `closed ${tabId}`,
      );
    },
    focused(sessionId, tabId) {
      update(
        sessionId,
        (base) => {
          const index = base.tabs.findIndex((tab) => tab.tabId === tabId);
          if (index === -1 || index === base.activeIndex) return null;
          return { ...base, activeIndex: index };
        },
        `focused ${tabId}`,
      );
    },
    resolved(sessionId, tabIds) {
      update(
        sessionId,
        (base) => {
          let changed = false;
          const tabs = base.tabs.map((tab, index) => {
            const resolvedId = tabIds[index];
            if (!resolvedId || resolvedId === tab.tabId) return tab;
            changed = true;
            return { ...tab, tabId: resolvedId };
          });
          return changed ? { ...base, tabs } : null;
        },
        "resolved ids",
      );
    },
  };
}
