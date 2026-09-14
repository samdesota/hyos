import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState, TabId } from "../../capabilities/browser.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  activeSideTab,
  adoptCreatedSideTab,
  createdHostTabId,
  initialSideTabScope,
  isPinnedSideTab,
  neighborSideTabId,
  NEW_SESSION_SCOPE_KEY,
  pinnedSideTabs,
  reconcileSideTabs,
  restoreSessionTabs,
  scopeBrowserTabIds,
  sideTabDescriptors,
  sideTabLabel,
  sideTabScopeKey,
  snapshotSessionTabs,
  unadoptedHostTab,
  type SideTab,
  type SideTabScope,
} from "./side-pane.js";

const browserSideTab = (tabId: TabId): SideTab => ({
  id: tabId,
  kind: "browser",
  tabId,
});

function hostState(tabIds: TabId[]): BrowserState {
  return {
    generation: 1,
    sequence: 1,
    activeTabId: tabIds[0] ?? null,
    tabs: tabIds.map((id) => ({
      id,
      url: `https://${id}.example/`,
      title: id,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    })),
  };
}

test("the patches tab is pinned to the strip and cannot be closed", () => {
  assert.deepEqual(pinnedSideTabs, [{ id: "patches", kind: "patches" }]);
  assert.equal(isPinnedSideTab({ id: "patches", kind: "patches" }), true);
  assert.equal(isPinnedSideTab(browserSideTab("tab-1")), false);
});

test("the pane shows the active tab, falling back to a pinned tab on a stale id", () => {
  const tabs = [...pinnedSideTabs, browserSideTab("tab-1")];
  assert.equal(activeSideTab(tabs, "tab-1")?.id, "tab-1");
  assert.equal(activeSideTab(tabs, "patches")?.id, "patches");
  assert.equal(activeSideTab(tabs, null)?.id, "patches");
  // Dynamic tab ids disappear (closed, or dropped by a hot reload); the
  // selection must fall back to the pinned tab instead of blanking.
  assert.equal(activeSideTab(tabs, "tab-9")?.id, "patches");
  assert.equal(activeSideTab([], null), null);
});

test("every tab kind has a strip descriptor with a label and glyph", () => {
  for (const kind of ["patches", "browser"] as const) {
    const descriptor = sideTabDescriptors[kind];
    assert.ok(descriptor.label.length > 0);
    assert.ok(descriptor.icon.length > 0);
  }
});

test("+ adopts the first host tab the strip does not already show", () => {
  const state = hostState(["tab-1", "tab-2"]);
  assert.equal(unadoptedHostTab(state, pinnedSideTabs)?.id, "tab-1");
  assert.equal(
    unadoptedHostTab(state, [...pinnedSideTabs, browserSideTab("tab-1")])?.id,
    "tab-2",
  );
  assert.equal(
    unadoptedHostTab(state, [
      ...pinnedSideTabs,
      browserSideTab("tab-1"),
      browserSideTab("tab-2"),
    ]),
    null,
  );
  // A host with no tabs at all has nothing to adopt.
  assert.equal(unadoptedHostTab(emptyBrowserState, pinnedSideTabs), null);
});

test("reconciliation drops browser tabs the host no longer knows", () => {
  const tabs = [
    ...pinnedSideTabs,
    browserSideTab("tab-1"),
    browserSideTab("tab-2"),
  ];
  // A hot reload recreates browser.main and its tab ids.
  const reloaded = reconcileSideTabs(tabs, hostState(["tab-1"]));
  assert.deepEqual(reloaded, [...pinnedSideTabs, browserSideTab("tab-1")]);
  // Nothing stale: the same array comes back so publishes don't churn.
  assert.equal(reconcileSideTabs(tabs, hostState(["tab-1", "tab-2"])), tabs);
});

test("closing a side tab focuses the nearest remaining neighbor", () => {
  const tabs = [
    pinnedSideTabs[0],
    browserSideTab("tab-1"),
    browserSideTab("tab-2"),
  ];
  assert.equal(neighborSideTabId(tabs, "tab-2"), "tab-1");
  assert.equal(neighborSideTabId(tabs, "tab-1"), "tab-2");
  assert.equal(neighborSideTabId(tabs, "gone"), null);
});

test("browser strip tabs are labelled by their page title, with a fallback", () => {
  assert.equal(sideTabLabel(pinnedSideTabs[0], hostState([])), "Patches");
  assert.equal(
    sideTabLabel(browserSideTab("tab-1"), hostState(["tab-1"])),
    "tab-1",
  );
  assert.equal(sideTabLabel(browserSideTab("tab-9"), hostState([])), "Browser");
});

test("a session scope keys off its id, with a key for the new-session view", () => {
  assert.equal(sideTabScopeKey("session-1"), "session-1");
  assert.equal(sideTabScopeKey(null), NEW_SESSION_SCOPE_KEY);
});

test("a fresh scope shows only the pinned patches tab", () => {
  const scope = initialSideTabScope();
  assert.deepEqual(scope, { tabs: pinnedSideTabs, activeId: "patches" });
  assert.deepEqual(scopeBrowserTabIds(scope), []);
});

test("a scope's adopted host tab ids are exactly its browser tabs", () => {
  const scope: SideTabScope = {
    tabs: [...pinnedSideTabs, browserSideTab("tab-1"), browserSideTab("tab-2")],
    activeId: "tab-2",
  };
  assert.deepEqual(scopeBrowserTabIds(scope), ["tab-1", "tab-2"]);
});

test("adopting a stashed scope drops host tabs closed while the session was inactive", () => {
  const stashed: SideTabScope = {
    tabs: [...pinnedSideTabs, browserSideTab("tab-1"), browserSideTab("tab-2")],
    activeId: "tab-2",
  };
  // tab-2 was closed from another session while this one was inactive.
  const tabs = reconcileSideTabs(stashed.tabs, hostState(["tab-1"]));
  // The stale focused id falls back to the pinned tab instead of blanking.
  assert.equal(activeSideTab(tabs, stashed.activeId)?.id, "patches");
  assert.deepEqual(scopeBrowserTabIds({ tabs, activeId: stashed.activeId }), [
    "tab-1",
  ]);
});

test("snapshotting a scope stores its browser tabs and focused index", () => {
  const state = hostState(["tab-1", "tab-2"]);
  const scope: SideTabScope = {
    tabs: [...pinnedSideTabs, browserSideTab("tab-1"), browserSideTab("tab-2")],
    activeId: "tab-2",
  };
  assert.deepEqual(snapshotSessionTabs(scope, state), {
    tabs: [
      { kind: "browser", url: "https://tab-1.example/", title: "tab-1" },
      { kind: "browser", url: "https://tab-2.example/", title: "tab-2" },
    ],
    activeIndex: 1,
  });
  // The pinned tab focused: nothing browser-y to focus on restore.
  assert.deepEqual(
    snapshotSessionTabs({ ...scope, activeId: "patches" }, state),
    {
      tabs: [
        { kind: "browser", url: "https://tab-1.example/", title: "tab-1" },
        { kind: "browser", url: "https://tab-2.example/", title: "tab-2" },
      ],
      activeIndex: -1,
    },
  );
});

test("snapshotting skips stale host tabs and nulls a browser-free scope", () => {
  const state = hostState(["tab-1"]);
  const scope: SideTabScope = {
    tabs: [...pinnedSideTabs, browserSideTab("tab-1"), browserSideTab("tab-9")],
    activeId: "tab-9",
  };
  // tab-9 is already gone from the host; the stale focus focuses nothing.
  assert.deepEqual(snapshotSessionTabs(scope, state), {
    tabs: [{ kind: "browser", url: "https://tab-1.example/", title: "tab-1" }],
    activeIndex: -1,
  });
  // Only pinned tabs: nothing worth persisting, the store nulls it anyway.
  assert.equal(snapshotSessionTabs(initialSideTabScope(), state), null);
});

test("a snapshot restores back onto the same host tabs with focus intact", () => {
  const state = hostState(["tab-1", "tab-2"]);
  const scope: SideTabScope = {
    tabs: [...pinnedSideTabs, browserSideTab("tab-1"), browserSideTab("tab-2")],
    activeId: "tab-2",
  };
  assert.deepEqual(
    restoreSessionTabs(snapshotSessionTabs(scope, state), state),
    {
      placements: [
        { kind: "reuse", tabId: "tab-1", url: "https://tab-1.example/" },
        { kind: "reuse", tabId: "tab-2", url: "https://tab-2.example/" },
      ],
      activeIndex: 1,
    },
  );
});

test("restoring reuses host tabs by url and opens the rest fresh", () => {
  // The host restarted (browser.main hot reload): the old page is still open
  // under a new tab id, so the saved tab reuses it; the other url is gone.
  const state = hostState(["tab-7"]);
  const restored = restoreSessionTabs(
    {
      tabs: [
        { kind: "browser", url: "https://tab-7.example/", title: "kept" },
        { kind: "browser", url: "https://fresh.example/", title: "gone" },
      ],
      activeIndex: 1,
    },
    state,
  );
  assert.deepEqual(restored, {
    placements: [
      { kind: "reuse", tabId: "tab-7", url: "https://tab-7.example/" },
      { kind: "create", url: "https://fresh.example/" },
    ],
    activeIndex: 1,
  });
});

test("restoring never reuses one host tab for two saved entries", () => {
  const url = "https://tab-1.example/";
  const restored = restoreSessionTabs(
    {
      tabs: [
        { kind: "browser", url, title: "first" },
        { kind: "browser", url, title: "second" },
      ],
      activeIndex: 1,
    },
    hostState(["tab-1"]),
  );
  assert.deepEqual(restored, {
    placements: [
      { kind: "reuse", tabId: "tab-1", url },
      { kind: "create", url },
    ],
    activeIndex: 1,
  });
});

test("restoring falls back to no focus when the saved focus is unusable", () => {
  const state = hostState(["tab-1"]);
  const saved = {
    tabs: [{ kind: "browser", url: "https://tab-1.example/", title: "a" }],
    activeIndex: 3,
  } as const;
  // Out of range, negative, and non-integer focuses all restore unfocused;
  // the pane then falls back to its pinned tab.
  assert.equal(restoreSessionTabs(saved, state).activeIndex, -1);
  assert.equal(
    restoreSessionTabs({ ...saved, activeIndex: -1 }, state).activeIndex,
    -1,
  );
  assert.equal(
    restoreSessionTabs({ ...saved, activeIndex: 0.5 }, state).activeIndex,
    -1,
  );
  // Nothing saved: nothing to restore or focus.
  assert.deepEqual(restoreSessionTabs(null, state), {
    placements: [],
    activeIndex: -1,
  });
});

test("the tab a create call opened is the one absent from the previous state", () => {
  const before = hostState(["tab-1"]);
  assert.equal(
    createdHostTabId(before, hostState(["tab-1", "tab-2"])),
    "tab-2",
  );
  // Nothing new: the call failed or only refreshed existing tabs.
  assert.equal(createdHostTabId(before, before), null);
  // A tab disappearing is a close, not a creation.
  assert.equal(createdHostTabId(hostState(["tab-1", "tab-2"]), before), null);
});

test("a created host tab is appended to the strip, idempotently", () => {
  const tabs = [...pinnedSideTabs, browserSideTab("tab-1")];
  // A freshly created tab (a link click or a `+` create) lands at the end.
  assert.deepEqual(adoptCreatedSideTab(tabs, "tab-2"), [
    ...tabs,
    browserSideTab("tab-2"),
  ]);
  // Appending twice keeps one entry: the create-tab promise can resolve after
  // a publish already adopted the tab, and an external adoption must win.
  const once = adoptCreatedSideTab(tabs, "tab-2");
  assert.equal(adoptCreatedSideTab(once, "tab-2"), once);
  // An existing entry for the same host tab is never duplicated.
  assert.equal(adoptCreatedSideTab(tabs, "tab-1"), tabs);
});
