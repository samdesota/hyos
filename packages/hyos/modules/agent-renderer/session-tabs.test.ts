import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  createSessionTabsPersister,
  type SessionTabsTarget,
} from "./session-tabs.js";
import type { BrowserState } from "../../capabilities/browser.js";
import {
  pinnedSideTabs,
  reconcileSideTabs,
  snapshotSessionTabs,
  type SideTabScope,
} from "./side-pane.js";

const savedTabs = (url: string): SessionTabsTarget => ({
  sessionId: "session-1",
  tabs: { tabs: [{ kind: "browser", url, title: url }], activeIndex: 0 },
});

function harness(save: (target: SessionTabsTarget) => Promise<void>) {
  let snapshot: SessionTabsTarget | null = null;
  const persister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => snapshot,
    save,
  });
  return {
    persister,
    set: (next: SessionTabsTarget | null) => {
      snapshot = next;
    },
  };
}

// Drain the persister's save bookkeeping, which settles on microtasks —
// mock timers own setTimeout, so a timer-based sleep would never fire.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

test("a burst of publishes coalesces into one save taken at fire time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    // The pane keeps changing while the write is pending; a second publish
    // must not stack a second timer either.
    set(savedTabs("https://b.example/"));
    persister.request();
    mock.timers.tick(499);
    assert.equal(writes.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(writes, [savedTabs("https://b.example/")]);
    await settle();
  } finally {
    mock.timers.reset();
  }
});

test("flush persists immediately and cancels the pending write", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    persister.flush();
    assert.deepEqual(writes, [savedTabs("https://a.example/")]);
    mock.timers.tick(1_000);
    assert.equal(writes.length, 1);
    await settle();
  } finally {
    mock.timers.reset();
  }
});

test("unchanged snapshots are skipped; a new session or content writes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.flush();
    await settle();
    persister.flush();
    await settle();
    assert.equal(writes.length, 1);

    set({ ...savedTabs("https://a.example/"), sessionId: "session-2" });
    persister.flush();
    await settle();
    set({ ...savedTabs("https://b.example/"), sessionId: "session-2" });
    persister.flush();
    await settle();
    assert.deepEqual(
      writes.map(({ sessionId, tabs }) => [sessionId, tabs?.tabs[0].url]),
      [
        ["session-1", "https://a.example/"],
        ["session-2", "https://a.example/"],
        ["session-2", "https://b.example/"],
      ],
    );
  } finally {
    mock.timers.reset();
  }
});

test("a null snapshot writes nothing, but a cleared pane still writes null", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    // No active session: nothing to persist.
    set(null);
    persister.request();
    mock.timers.tick(1_000);
    assert.equal(writes.length, 0);

    // An active session whose browser tabs are all gone clears its row.
    set({ sessionId: "session-1", tabs: null });
    persister.flush();
    await settle();
    assert.deepEqual(writes, [{ sessionId: "session-1", tabs: null }]);
  } finally {
    mock.timers.reset();
  }
});

test("a failed save is swallowed and retried by the next flush", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    let down = true;
    const { persister, set } = harness(async (target) => {
      if (down) throw new Error("host unavailable");
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.flush();
    await settle();
    assert.equal(writes.length, 0);
    down = false;
    persister.flush();
    await settle();
    assert.deepEqual(writes, [savedTabs("https://a.example/")]);
  } finally {
    mock.timers.reset();
  }
});

test("dispose cancels a scheduled write without firing it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    persister.dispose();
    mock.timers.tick(1_000);
    assert.equal(writes.length, 0);
  } finally {
    mock.timers.reset();
  }
});

const hostTab = (id: string, url: string): BrowserState["tabs"][number] => ({
  id: id as BrowserState["tabs"][number]["id"],
  url,
  title: url,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
});

/**
/**
 * Reload regression: wiring the module pieces exactly as app-state.ts does —
 * snapshot taken at flush time from the live, reconciled strip — a window
 * reload must not wipe the saved session tabs. `browser.main` restarts first
 * (new host generation, new tab ids), the dying renderer's reconcile drops
 * the session's browser tabs, and the teardown `flush()` must NOT persist
 * the emptied strip as `null` — that would erase the DB row the remounted
 * renderer restores from. The generation guard suppresses any write taken
 * under a host generation the persister has not saved under yet.
 */
test("reload does not wipe saved session tabs via the teardown flush", async () => {
  const writes: SessionTabsTarget[] = [];
  let strip: SideTabScope = {
    tabs: [...pinnedSideTabs, { id: "tab-1", kind: "browser", tabId: "tab-1" }],
    activeId: "tab-1",
  };
  let hostState: BrowserState = {
    generation: 1,
    sequence: 1,
    activeTabId: "tab-1",
    tabs: [hostTab("tab-1", "https://a.example/")],
  };
  const persister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => ({
      sessionId: "session-1",
      tabs: snapshotSessionTabs(strip, hostState),
    }),
    generation: () => hostState.generation,
    save: async (target) => {
      writes.push(target);
    },
  });

  // Normal operation: the strip is persisted under its urls.
  persister.flush();
  await settle();
  assert.deepEqual(writes[0]?.tabs?.tabs, [
    { kind: "browser", url: "https://a.example/", title: "https://a.example/" },
  ]);

  // Window reload: browser.main is recreated — new generation, new tab ids,
  // and the old renderer processes the new host's first publish.
  hostState = {
    generation: 2,
    sequence: 0,
    activeTabId: "tab-9",
    tabs: [hostTab("tab-9", "https://example.com/")],
  };
  strip = {
    tabs: reconcileSideTabs(strip.tabs, hostState),
    activeId: null,
  };
  assert.deepEqual(strip.tabs, pinnedSideTabs);

  // The dying renderer's onCleanup calls tabsPersister.flush(): the
  // reconciled strip must NOT be persisted — the DB keeps the saved urls
  // for the remounted renderer's restoreSavedTabs.
  persister.flush();
  await settle();
  assert.equal(writes.length, 1);
});

// The guard is keyed to the host generation, not to the wipe shape: a user
// genuinely closing every browser tab under the same host incarnation still
// clears the row.
test("clearing the pane under the same generation still writes null", async () => {
  const writes: SessionTabsTarget[] = [];
  let strip: SideTabScope = {
    tabs: [...pinnedSideTabs, { id: "tab-1", kind: "browser", tabId: "tab-1" }],
    activeId: "patches",
  };
  const hostState: BrowserState = {
    generation: 1,
    sequence: 1,
    activeTabId: "tab-1",
    tabs: [hostTab("tab-1", "https://a.example/")],
  };
  const persister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => ({
      sessionId: "session-1",
      tabs: snapshotSessionTabs(strip, hostState),
    }),
    generation: () => hostState.generation,
    save: async (target) => {
      writes.push(target);
    },
  });

  persister.flush();
  await settle();
  strip = { tabs: pinnedSideTabs, activeId: "patches" };
  persister.flush();
  await settle();
  assert.deepEqual(writes, [
    {
      sessionId: "session-1",
      tabs: {
        tabs: [
          {
            kind: "browser",
            url: "https://a.example/",
            title: "https://a.example/",
          },
        ],
        activeIndex: -1,
      },
    },
    { sessionId: "session-1", tabs: null },
  ]);
});

// A fresh renderer instance after the reload starts a new persister whose
// first save lands under the new generation: it must not be suppressed, or
// the restored strip would never be persisted again.
test("a fresh persister saves under the new generation after the reload", async () => {
  const writes: SessionTabsTarget[] = [];
  // Post-restore state of the remounted renderer: the restored strip is
  // live under the new host generation.
  const strip: SideTabScope = {
    tabs: [...pinnedSideTabs, { id: "tab-2", kind: "browser", tabId: "tab-2" }],
    activeId: "tab-2",
  };
  const hostState: BrowserState = {
    generation: 2,
    sequence: 3,
    activeTabId: "tab-2",
    tabs: [hostTab("tab-2", "https://a.example/")],
  };
  const persister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => ({
      sessionId: "session-1",
      tabs: snapshotSessionTabs(strip, hostState),
    }),
    generation: () => hostState.generation,
    save: async (target) => {
      writes.push(target);
    },
  });

  persister.flush();
  await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.tabs?.tabs, [
    { kind: "browser", url: "https://a.example/", title: "https://a.example/" },
  ]);
});
