import type { AgentSessionTabs } from "../../capabilities/agent.js";

/** A pending pane write: which session row to update, and with what. */
export type SessionTabsTarget = Readonly<{
  sessionId: string;
  tabs: AgentSessionTabs | null;
}>;

/**
 * Debounced persistence for a session's side-pane tabs. The host publishes
 * browser state for every loading tick, so writes are coalesced: a burst of
 * publishes schedules one write, and the snapshot is taken when the write
 * fires — never when it is scheduled — so it always describes the pane as of
 * the flush. Unchanged snapshots are skipped, and failures are swallowed:
 * this is background pane state, not user data.
 */
export function createSessionTabsPersister(
  options: Readonly<{
    delay: number;
    snapshot: () => SessionTabsTarget | null;
    /** The live browser host generation; enables the reload guard below. */
    generation?: () => number;
    save: (target: SessionTabsTarget) => Promise<void>;
  }>,
): Readonly<{ request(): void; flush(): void; dispose(): void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedSessionId: string | null = null;
  let savedJson: string | null = null;
  let savedGeneration: number | null = null;

  const fire = (): void => {
    timer = undefined;
    const target = options.snapshot();
    if (!target) return;
    const generation = options.generation?.() ?? null;
    // Reload guard: a browser.main restart rotates the host generation, and
    // a snapshot taken under a generation this persister has never saved
    // under describes tabs lost to that restart — not user intent. The
    // dying renderer's teardown flush would otherwise persist the reconciled
    // (emptied) strip and wipe the saved record a remounted renderer
    // restores from. Writes are suppressed until a fresh instance (the
    // remount's persister, after its restore) saves under the new
    // generation; without `generation`, no suppression applies.
    if (
      savedGeneration !== null &&
      generation !== null &&
      generation !== savedGeneration
    ) {
      return;
    }
    const json = JSON.stringify(target.tabs);
    if (target.sessionId === savedSessionId && json === savedJson) return;
    // Bookkeeping only after the save resolves, so a failed write is
    // retried by the next flush instead of being assumed persisted.
    void options
      .save(target)
      .then(() => {
        savedSessionId = target.sessionId;
        savedJson = json;
        savedGeneration = generation;
      })
      .catch(() => undefined);
  };

  return {
    // One write per quiet window no matter how many publishes land in it;
    // a write already scheduled picks up the latest state when it fires.
    request() {
      if (timer) return;
      timer = setTimeout(fire, options.delay);
    },
    // Persist right now — used when the pane is about to swap scopes, so
    // the outgoing session's latest strip lands under its own id.
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
