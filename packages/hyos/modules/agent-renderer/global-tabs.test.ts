import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState, TabId } from "../../capabilities/browser.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  activeGlobalTab,
  createdHostTabId,
  globalTabDescriptors,
  globalTabLabel,
  neighborGlobalTabId,
  reconcileGlobalTabs,
  restoreGlobalTabs,
  snapshotGlobalTabs,
  unadoptedGlobalHostTab,
  type GlobalTab,
} from "./global-tabs.js";

const browserGlobalTab = (tabId: TabId): GlobalTab => ({
  id: tabId,
  kind: "browser",
  tabId,
});

function hostState(
  tabs: Readonly<{ id: TabId; url?: string; title?: string }[]>,
  activeTabId: TabId | null = tabs[0]?.id ?? null,
): BrowserState {
  return {
    generation: 1,
    sequence: 1,
    activeTabId,
    tabs: tabs.map(({ id, url, title }) => ({
      id,
      url: url ?? `https://${id}.example/`,
      title: title ?? id,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    })),
  };
}

test("the active tab is shown only while it exists; a stale id shows nothing", () => {
  const tabs = [browserGlobalTab("tab-1"), browserGlobalTab("tab-2")];
  assert.equal(activeGlobalTab(tabs, "tab-2")?.id, "tab-2");
  assert.equal(activeGlobalTab(tabs, "tab-9"), null);
  assert.equal(activeGlobalTab(tabs, null), null);
});

test("labels prefer the presented page title over the kind fallback", () => {
  const state = hostState([
    { id: "tab-1", title: "HyOS" },
    { id: "tab-2", title: "   " },
  ]);
  assert.equal(globalTabLabel(browserGlobalTab("tab-1"), state), "HyOS");
  assert.equal(
    globalTabLabel(browserGlobalTab("tab-2"), state),
    globalTabDescriptors.browser.label,
  );
});

test("`+` adopts an unshown host tab instead of creating a duplicate", () => {
  const tabs = [browserGlobalTab("tab-1")];
  assert.equal(
    unadoptedGlobalHostTab(hostState([{ id: "tab-1" }]), tabs),
    null,
  );
  const adoptable = unadoptedGlobalHostTab(
    hostState([{ id: "tab-1" }, { id: "tab-2" }]),
    tabs,
  );
  assert.equal(adoptable?.id, "tab-2");
  assert.equal(unadoptedGlobalHostTab(emptyBrowserState, tabs), null);
});

test("reconciliation drops tabs the host no longer knows and no-ops otherwise", () => {
  const tabs = [browserGlobalTab("tab-1"), browserGlobalTab("tab-2")];
  assert.deepEqual(reconcileGlobalTabs(tabs, hostState([{ id: "tab-1" }])), [
    browserGlobalTab("tab-1"),
  ]);
  assert.equal(
    reconcileGlobalTabs(tabs, hostState([{ id: "tab-1" }, { id: "tab-2" }])),
    tabs,
  );
});

test("closing focuses the next neighbor, else the previous one", () => {
  const tabs = [
    browserGlobalTab("tab-1"),
    browserGlobalTab("tab-2"),
    browserGlobalTab("tab-3"),
  ];
  assert.equal(neighborGlobalTabId(tabs, "tab-1"), "tab-2");
  assert.equal(neighborGlobalTabId(tabs, "tab-2"), "tab-3");
  assert.equal(neighborGlobalTabId(tabs, "tab-3"), "tab-2");
  assert.equal(neighborGlobalTabId(tabs, "tab-9"), null);
  assert.equal(neighborGlobalTabId([], "tab-1"), null);
});

test("the snapshot keeps url/title and the focused index, or null when empty", () => {
  const state = hostState([
    { id: "tab-1", url: "https://a.example/", title: "A" },
    { id: "tab-2", url: "https://b.example/", title: "B" },
  ]);
  assert.equal(snapshotGlobalTabs({ tabs: [], activeId: null }, state), null);
  const scope = {
    tabs: [browserGlobalTab("tab-1"), browserGlobalTab("tab-2")],
    activeId: "tab-2",
  };
  assert.deepEqual(snapshotGlobalTabs(scope, state), {
    tabs: [
      { kind: "browser", url: "https://a.example/", title: "A" },
      { kind: "browser", url: "https://b.example/", title: "B" },
    ],
    activeIndex: 1,
  });
  // A stale focus, or nothing browser-y focused, restores as -1.
  const stale = snapshotGlobalTabs({ ...scope, activeId: "tab-9" }, state);
  assert.equal(stale?.activeIndex, -1);
});

test("restore reuses live tabs by url and creates only unmatched urls", () => {
  const state = hostState([
    { id: "tab-1", url: "https://a.example/" },
    { id: "tab-2", url: "https://b.example/" },
  ]);
  assert.deepEqual(restoreGlobalTabs(null, state), {
    placements: [],
    activeIndex: -1,
  });
  const restore = restoreGlobalTabs(
    {
      tabs: [
        { kind: "browser", url: "https://b.example/", title: "B" },
        { kind: "browser", url: "https://c.example/", title: "C" },
      ],
      activeIndex: 0,
    },
    state,
  );
  assert.deepEqual(restore.placements, [
    { kind: "reuse", tabId: "tab-2", url: "https://b.example/" },
    { kind: "create", url: "https://c.example/" },
  ]);
  assert.equal(restore.activeIndex, 0);
  // Out-of-range or non-integer focus indices fall back to -1.
  assert.equal(
    restoreGlobalTabs(
      {
        tabs: [{ kind: "browser", url: "https://b.example/", title: "B" }],
        activeIndex: 5,
      },
      state,
    ).activeIndex,
    -1,
  );
  // A url appearing twice in the saved strip cannot reuse the same host tab.
  const duplicate = restoreGlobalTabs(
    {
      tabs: [
        { kind: "browser", url: "https://a.example/", title: "A" },
        { kind: "browser", url: "https://a.example/", title: "A" },
      ],
      activeIndex: -1,
    },
    state,
  );
  assert.deepEqual(duplicate.placements, [
    { kind: "reuse", tabId: "tab-1", url: "https://a.example/" },
    { kind: "create", url: "https://a.example/" },
  ]);
});

test("createdHostTabId is re-exported and detects the tab a create added", () => {
  const before = hostState([{ id: "tab-1" }]);
  const after = hostState([{ id: "tab-1" }, { id: "tab-2" }]);
  assert.equal(createdHostTabId(before, after), "tab-2");
  assert.equal(createdHostTabId(before, before), null);
});
