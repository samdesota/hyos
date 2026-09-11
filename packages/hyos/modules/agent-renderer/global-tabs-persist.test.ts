import assert from "node:assert/strict";
import test from "node:test";

import { emptyBrowserState } from "./browser-tab.js";
import { snapshotGlobalTabs, type GlobalTabsSnapshot } from "./global-tabs.js";
import {
  createGlobalTabsPersister,
  rowsFromSnapshot,
  snapshotFromRows,
} from "./global-tabs-persist.js";

const browserGlobalTab = (tabId: string) => ({
  id: tabId,
  kind: "browser" as const,
  tabId,
});
const whiteboardTab = (boardId: string) => ({
  id: `global-whiteboard-${boardId}`,
  kind: "whiteboard" as const,
  boardId,
});

test("rows round-trip through a snapshot, focus included", () => {
  const snapshot = snapshotGlobalTabs(
    {
      tabs: [
        whiteboardTab("board-1"),
        browserGlobalTab("tab-1"),
        browserGlobalTab("tab-2"),
      ],
      activeId: "tab-2",
    },
    {
      ...emptyBrowserState,
      tabs: [
        { id: "tab-1", url: "https://a.example/", title: "A" },
        { id: "tab-2", url: "https://b.example/", title: "B" },
      ].map((tab) => ({
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        ...tab,
      })),
    },
  );
  assert.ok(snapshot);
  const rows = rowsFromSnapshot(snapshot);
  assert.deepEqual(
    rows.map(({ id, active, position }) => ({ id, active, position })),
    [
      { id: "global-0", active: false, position: 0 },
      { id: "global-1", active: false, position: 1 },
      { id: "global-2", active: true, position: 2 },
    ],
  );
  assert.deepEqual(snapshotFromRows(rows), snapshot);
});

test("an unfocused strip restores with a -1 focus index", () => {
  const rows = rowsFromSnapshot({
    tabs: [{ kind: "whiteboard", boardId: "board-1" }],
    activeIndex: -1,
  });
  assert.deepEqual(snapshotFromRows(rows), {
    tabs: [{ kind: "whiteboard", boardId: "board-1" }],
    activeIndex: -1,
  });
});

test("snapshotFromRows sorts defensively and reads empty as null", () => {
  assert.equal(snapshotFromRows([]), null);
  const rows = rowsFromSnapshot({
    tabs: [
      { kind: "browser", url: "https://a.example/", title: "A" },
      { kind: "whiteboard", boardId: "board-1" },
    ],
    activeIndex: 1,
  });
  assert.deepEqual(snapshotFromRows([rows[1], rows[0]]), {
    tabs: [
      { kind: "browser", url: "https://a.example/", title: "A" },
      { kind: "whiteboard", boardId: "board-1" },
    ],
    activeIndex: 1,
  });
});

test("the persister coalesces bursts and skips unchanged snapshots", async () => {
  let saved: readonly number[] = [];
  let calls = 0;
  let strip: GlobalTabsSnapshot | null = {
    tabs: [{ kind: "whiteboard", boardId: "board-1" }],
    activeIndex: -1,
  };
  const persister = createGlobalTabsPersister({
    delay: 5,
    snapshot: () => strip,
    save: (rows) => {
      calls += 1;
      saved = [...saved, rows.length];
      return Promise.resolve();
    },
  });
  // A burst of mutations inside one quiet window writes once, with the
  // snapshot taken when the write fires — not when it was scheduled.
  persister.request();
  persister.request();
  strip = {
    tabs: [
      { kind: "whiteboard", boardId: "board-1" },
      { kind: "browser", url: "https://a.example/", title: "A" },
    ],
    activeIndex: -1,
  };
  persister.request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(saved, [2]);
  assert.equal(calls, 1);
  // An unchanged strip is not rewritten.
  persister.request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  // Flush persists immediately, including a change to null (strip emptied).
  strip = null;
  persister.flush();
  assert.deepEqual(saved, [2, 0]);
  persister.dispose();
});

test("a failed write is retried by the next flush", async () => {
  let fail = true;
  let calls = 0;
  const persister = createGlobalTabsPersister({
    delay: 5,
    snapshot: () => ({ tabs: [], activeIndex: -1 }),
    save: () => {
      calls += 1;
      return fail ? Promise.reject(new Error("down")) : Promise.resolve();
    },
  });
  persister.flush();
  await Promise.resolve();
  persister.flush();
  assert.equal(calls, 2);
  fail = false;
  persister.flush();
  await Promise.resolve();
  assert.equal(calls, 3);
  // Now persisted, an unchanged strip is no longer rewritten.
  persister.flush();
  assert.equal(calls, 3);
  persister.dispose();
});
