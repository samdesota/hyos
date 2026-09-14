import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState, TabId } from "../../capabilities/browser.js";
import { emptyBrowserState } from "./browser-tab.js";
import {
  TabCreateLedger,
  activeSideTab,
  adoptCreatedSideTab,
  createdHostTabId,
  isPinnedSideTab,
  neighborSideTabId,
  pinnedSideTabs,
  reconcileSideTabs,
  normalizeTabUrl,
  restoreSessionTabs,
  sideTabDescriptors,
  urlMatches,
  sideTabLabel,
  unadoptedHostTab,
  type SideTab,
} from "./side-pane.js";

const browserSideTab = (tabId: TabId): SideTab => ({
  id: tabId,
  kind: "browser",
  tabId,
});

function hostState(
  tabIds: TabId[],
  tabs: BrowserState["tabs"] = tabIds.map((id) => ({
    id,
    url: `https://${id}.example/`,
    title: id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  })),
): BrowserState {
  return {
    generation: 1,
    sequence: 1,
    activeTabId: tabIds[0] ?? null,
    tabs,
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

test("restoring adopts the persisted host tab by id, verified against its url", () => {
  const state = hostState(["tab-1", "tab-2"]);
  assert.deepEqual(
    restoreSessionTabs(
      {
        tabs: [
          { kind: "browser", tabId: "tab-1", url: "https://tab-1.example/" },
          { kind: "browser", tabId: "tab-2", url: "https://tab-2.example/" },
        ],
        activeIndex: 1,
      },
      state,
    ),
    {
      placements: [
        { kind: "reuse", tabId: "tab-1", url: "https://tab-1.example/" },
        { kind: "reuse", tabId: "tab-2", url: "https://tab-2.example/" },
      ],
      activeIndex: 1,
    },
  );
});

test("a persisted id is adopted by id alone, whatever url the live tab shows", () => {
  // Ids are UUIDs, so a live persisted id is the recorded tab regardless of
  // how far its url drifted (challenge tokens, redirects, even navigation) —
  // the tab is adopted instead of creating a duplicate. A dead id still
  // falls back: url match for a still-open page, create otherwise.
  const state = hostState(["tab-1", "tab-2"]);
  const drifted = {
    ...state,
    tabs: [
      {
        ...state.tabs[0],
        url: "https://tab-1.example/search?q=chime&__cf_chl_rt_tk=fresh",
      },
      { ...state.tabs[1], url: "https://other.example/other" },
    ],
  };
  assert.deepEqual(
    restoreSessionTabs(
      {
        tabs: [
          { kind: "browser", tabId: "tab-1", url: "https://gone.example/" },
          { kind: "browser", tabId: "tab-2", url: "https://other.example/" },
        ],
        activeIndex: 0,
      },
      drifted,
    ),
    {
      placements: [
        { kind: "reuse", tabId: "tab-1", url: "https://gone.example/" },
        { kind: "reuse", tabId: "tab-2", url: "https://other.example/" },
      ],
      activeIndex: 0,
    },
  );
});

test("a persisted id missing from the host falls back to the url match", () => {
  // The host was restarted: the recorded tab is gone. The recorded url still
  // finds a live tab with the same page; an unknown url opens fresh.
  const state = {
    ...hostState(["tab-7"]),
    tabs: [hostState(["tab-7"]).tabs[0]],
  };
  assert.deepEqual(
    restoreSessionTabs(
      {
        tabs: [
          { kind: "browser", tabId: "tab-1", url: "https://tab-7.example/" },
          { kind: "browser", tabId: "tab-2", url: "https://gone.example/" },
        ],
        activeIndex: 0,
      },
      state,
    ),
    {
      placements: [
        { kind: "reuse", tabId: "tab-7", url: "https://tab-7.example/" },
        { kind: "create", url: "https://gone.example/" },
      ],
      activeIndex: 0,
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
        { kind: "browser", tabId: "tab-3", url: "https://tab-7.example/" },
        { kind: "browser", tabId: "tab-4", url: "https://fresh.example/" },
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
        { kind: "browser", tabId: "tab-5", url },
        { kind: "browser", tabId: "tab-6", url },
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
    tabs: [{ kind: "browser", tabId: "tab-1", url: "https://tab-1.example/" }],
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

test("normalizeTabUrl strips Cloudflare challenge tokens but keeps the page", () => {
  const challenged =
    "https://pixabay.com/sound-effects/search/chime/?__cf_chl_rt_tk=abc-123&keep=1";
  assert.equal(
    normalizeTabUrl(challenged),
    "https://pixabay.com/sound-effects/search/chime/?keep=1",
  );
  assert.equal(
    normalizeTabUrl(
      "https://pixabay.com/sound-effects/search/chime?__cf_chl_tk=x",
    ),
    "https://pixabay.com/sound-effects/search/chime",
  );
  assert.equal(
    normalizeTabUrl("https://pixabay.com/sound-effects/search/chime/?keep=1"),
    normalizeTabUrl(challenged),
  );
  // Non-url junk passes through untouched.
  assert.equal(normalizeTabUrl("not a url"), "not a url");
});

test("urlMatches ignores challenge-token churn on either side", () => {
  assert.equal(
    urlMatches(
      "https://example.com/page?__cf_chl_rt_tk=one",
      "https://example.com/page?__cf_chl_rt_tk=two",
    ),
    true,
  );
  assert.equal(
    urlMatches("https://example.com/page", "https://example.com/other"),
    false,
  );
});

test("a live tab mid-challenge matches the recorded url token-for-token stripped", () => {
  // Recorded url is clean; live tab was re-navigated with a challenge token.
  const state = hostState(
    ["tab-7"],
    [
      {
        id: "tab-7",
        url: "https://page.example/doc?__cf_chl_rt_tk=fresh",
        title: "Doc",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
      },
    ],
  );
  const restored = restoreSessionTabs(
    {
      tabs: [
        { kind: "browser", tabId: "tab-1", url: "https://page.example/doc" },
      ],
      activeIndex: 0,
    },
    state,
  );
  assert.deepEqual(restored, {
    placements: [
      {
        kind: "reuse",
        tabId: "tab-7",
        url: "https://page.example/doc",
      },
    ],
    activeIndex: 0,
  });
});

test("TabCreateLedger: createOnce is single-flight per normalized url", async () => {
  const ledger = new TabCreateLedger();
  let calls = 0;
  const first = ledger.createOnce(
    "https://x.example/a?__cf_chl_rt_tk=1",
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "tab-a";
    },
  );
  const second = ledger.createOnce(
    "https://x.example/a?__cf_chl_rt_tk=2",
    async () => {
      calls += 1;
      return "tab-dup";
    },
  );
  assert.equal(await first, "tab-a");
  assert.equal(await second, "tab-a");
  assert.equal(calls, 1);
  // Settled: a later create for a different page runs its own create.
  assert.equal(
    await ledger.createOnce("https://x.example/b", async () => {
      calls += 1;
      return "tab-b";
    }),
    "tab-b",
  );
  assert.equal(calls, 2);
});

test("TabCreateLedger: createdFor remembers the produced tab and forget retires it", async () => {
  const ledger = new TabCreateLedger();
  await ledger.createOnce(
    "https://x.example/a?__cf_chl_tk=z",
    async () => "tab-a",
  );
  assert.equal(ledger.createdFor("https://x.example/a"), "tab-a");
  assert.equal(
    ledger.createdFor("https://x.example/a?__cf_chl_rt_tk=new"),
    "tab-a",
  );
  ledger.forget("tab-a");
  assert.equal(ledger.createdFor("https://x.example/a"), null);
});
