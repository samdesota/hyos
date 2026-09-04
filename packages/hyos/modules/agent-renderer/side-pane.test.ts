import assert from "node:assert/strict";
import test from "node:test";

import {
  activeSideTab,
  isPinnedSideTab,
  pinnedSideTabs,
  sideTabDescriptors,
} from "./side-pane.js";

test("the patches tab is pinned to the strip and cannot be closed", () => {
  assert.deepEqual(pinnedSideTabs, [{ id: "patches", kind: "patches" }]);
  assert.equal(isPinnedSideTab({ id: "patches", kind: "patches" }), true);
});

test("the pane shows the active tab, falling back to a pinned tab on a stale id", () => {
  assert.equal(activeSideTab(pinnedSideTabs, "patches")?.id, "patches");
  assert.equal(activeSideTab(pinnedSideTabs, null)?.id, "patches");
  // Dynamic tab ids disappear (closed, or dropped by a hot reload); the
  // selection must fall back to the pinned tab instead of blanking.
  assert.equal(activeSideTab(pinnedSideTabs, "tab-9")?.id, "patches");
  assert.equal(activeSideTab([], null), null);
});

test("every tab kind has a strip descriptor with a label and glyph", () => {
  const kinds = new Set(pinnedSideTabs.map((tab) => tab.kind));
  assert.ok(kinds.size > 0);
  for (const kind of kinds) {
    const descriptor = sideTabDescriptors[kind];
    assert.ok(descriptor.label.length > 0);
    assert.ok(descriptor.icon.length > 0);
  }
});
