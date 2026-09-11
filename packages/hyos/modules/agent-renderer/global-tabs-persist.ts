import type { AgentGlobalTabRow } from "../../capabilities/agent.js";
import type { GlobalTabsSnapshot } from "./global-tabs.js";

/**
 * The persisted strip as store rows: one row per snapshot entry, in strip
 * order. Row ids are positional — the strip is always replaced wholesale,
 * so ids only need to be unique within one replacement — and exactly one
 * row carries `active`, mirroring the snapshot's focus index.
 */
export function rowsFromSnapshot(
  snapshot: GlobalTabsSnapshot,
): readonly AgentGlobalTabRow[] {
  return snapshot.tabs.map((tab, position) => ({
    id: `global-${position}`,
    data:
      tab.kind === "browser"
        ? { kind: "browser", url: tab.url, title: tab.title }
        : { kind: "whiteboard", boardId: tab.boardId },
    active: position === snapshot.activeIndex,
    position,
  }));
}

/**
 * Loaded rows as a snapshot: ordered by position, with the active row's
 * position as the focus index (-1 when no row is active — an unfocused
 * strip is a valid persisted state, not an error).
 */
export function snapshotFromRows(
  rows: readonly AgentGlobalTabRow[],
): GlobalTabsSnapshot | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  return {
    tabs: ordered.map((row) =>
      row.data.kind === "browser"
        ? { kind: "browser", url: row.data.url, title: row.data.title }
        : { kind: "whiteboard", boardId: row.data.boardId },
    ),
    activeIndex: ordered.findIndex((row) => row.active),
  };
}

/**
 * Debounced persistence for the global tab strip. Browser publishes churn
 * tab titles on every loading tick, so writes are coalesced: a burst
 * schedules one write, and the snapshot is taken when it fires — never when
 * it is scheduled. Unchanged snapshots are skipped, and failures are
 * swallowed: this is background pane state, not user data.
 */
export function createGlobalTabsPersister(
  options: Readonly<{
    delay: number;
    snapshot: () => GlobalTabsSnapshot | null;
    save: (rows: readonly AgentGlobalTabRow[]) => Promise<void>;
  }>,
): Readonly<{ request(): void; flush(): void; dispose(): void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedJson: string | null = null;

  const fire = (): void => {
    timer = undefined;
    const snapshot = options.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === savedJson) return;
    // Bookkeeping only after the save resolves, so a failed write is
    // retried by the next flush instead of being assumed persisted.
    void options
      .save(snapshot ? rowsFromSnapshot(snapshot) : [])
      .then(() => {
        savedJson = json;
      })
      .catch(() => undefined);
  };

  return {
    // One write per quiet window no matter how many mutations land in it;
    // a write already scheduled picks up the latest state when it fires.
    request() {
      if (timer) return;
      timer = setTimeout(fire, options.delay);
    },
    // Persist right now — used on teardown, so the pending timer dying
    // with the renderer does not drop the last strip change.
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
