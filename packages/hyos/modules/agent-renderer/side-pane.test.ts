import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState, TabId } from "../../capabilities/browser.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  activeSideTab,
  autoAdoptHostTabs,
  initialSideTabScope,
  isPinnedSideTab,
  neighborSideTabId,
  NEW_SESSION_SCOPE_KEY,
  pinnedSideTabs,
  reconcileSideTabs,
  scopeBrowserTabIds,
  sideTabDescriptors,
  sideTabLabel,
  sideTabScopeKey,
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

test("auto-adoption adopts and focuses host tabs that appear in a publish", () => {
  // An agent's browser_open_tab created tab-2 between two publishes.
  const adopted = autoAdoptHostTabs(
    pinnedSideTabs,
    hostState(["tab-1", "tab-2"]),
    hostState(["tab-1"]),
  );
  assert.deepEqual(adopted?.tabs, [...pinnedSideTabs, browserSideTab("tab-2")]);
  assert.equal(adopted?.activeId, "tab-2");
});

test("auto-adoption ignores first observations and host restarts", () => {
  const state = hostState(["tab-1", "tab-2"]);
  // No previous publish: nothing counts as new, so a fresh strip keeps the
  // host's boot tab hidden until the user adopts it.
  assert.equal(autoAdoptHostTabs(pinnedSideTabs, state, null), null);
  // A publish that lands before the boot snapshot is also a first view.
  assert.equal(
    autoAdoptHostTabs(pinnedSideTabs, state, emptyBrowserState),
    null,
  );
  // A new generation recreated the host's tabs (browser.main hot reload);
  // those are re-seeded, not adopted.
  assert.equal(
    autoAdoptHostTabs(pinnedSideTabs, { ...state, generation: 2 }, state),
    null,
  );
});

test("auto-adoption never duplicates tabs the strip already shows", () => {
  const tabs = [
    ...pinnedSideTabs,
    browserSideTab("tab-1"),
    browserSideTab("tab-2"),
  ];
  // tab-2 appeared in this publish, but the strip adopted it already (the
  // `+` click beat the publish).
  assert.equal(
    autoAdoptHostTabs(
      tabs,
      hostState(["tab-1", "tab-2"]),
      hostState(["tab-1"]),
    ),
    null,
  );
  // Nothing new at all: routine publishes leave the strip untouched.
  assert.equal(
    autoAdoptHostTabs(
      tabs,
      hostState(["tab-1", "tab-2"]),
      hostState(["tab-1", "tab-2"]),
    ),
    null,
  );
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
