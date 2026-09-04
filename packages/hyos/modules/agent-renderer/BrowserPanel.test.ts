import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState } from "../../capabilities/browser.js";
import {
  activeTabOf,
  emptyBrowserState,
  toolbarAddress,
} from "./BrowserPanel.js";

function browserState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    ...emptyBrowserState,
    generation: 1,
    sequence: 2,
    activeTabId: "tab-1",
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
      },
      {
        id: "tab-2",
        url: "https://hyos.dev/",
        title: "HyOS",
        loading: false,
        canGoBack: true,
        canGoForward: false,
        error: null,
      },
    ],
    ...overrides,
  };
}

test("the browser panel presents the active tab", () => {
  assert.equal(activeTabOf(browserState())?.id, "tab-1");
  assert.equal(
    activeTabOf(browserState({ activeTabId: "tab-2" }))?.url,
    "https://hyos.dev/",
  );
});

test("a missing or stale active tab presents nothing", () => {
  assert.equal(activeTabOf(emptyBrowserState), null);
  assert.equal(activeTabOf(browserState({ activeTabId: null })), null);
  // Tab ids change when browser.main hot-reloads; a stale id must not
  // present a presentation the host no longer knows.
  assert.equal(activeTabOf(browserState({ activeTabId: "tab-9" })), null);
});

test("the toolbar keeps a draft address while editing and follows the tab otherwise", () => {
  const tab = activeTabOf(browserState());
  assert.equal(toolbarAddress("https://a.dev/", tab, true), "https://a.dev/");
  assert.equal(
    toolbarAddress("https://a.dev/", tab, false),
    "https://example.com/",
  );
  assert.equal(toolbarAddress("https://a.dev/", null, false), "https://a.dev/");
});
