import assert from "node:assert/strict";
import test from "node:test";

import {
  computePanelPosition,
  isDismissKey,
  isOutsideOverlay,
  viewportMargin,
  type OverlayNode,
} from "./popover-layout.js";

const viewport = { width: 800, height: 600 };
const panel = { left: 0, top: 0, width: 200, height: 100 };

const stubNode = (children: unknown[] = []): OverlayNode => ({
  contains: (node) => children.includes(node),
});

test("the panel sits below the anchor inside the viewport", () => {
  const anchor = { left: 20, top: 10, width: 26, height: 26 };
  const position = computePanelPosition(anchor, panel, viewport);
  assert.equal(position.flipped, false);
  assert.equal(position.left, 20);
  assert.equal(position.top, 10 + 26 + viewportMargin);
});

test("a panel that overflows the bottom flips above the anchor", () => {
  const anchor = { left: 20, top: 550, width: 26, height: 26 };
  const position = computePanelPosition(anchor, panel, viewport);
  assert.equal(position.flipped, true);
  assert.equal(position.top, 550 - 100 - viewportMargin);
});

test("a panel taller than the space above the anchor is clamped to the top margin", () => {
  const anchor = { left: 20, top: 550, width: 26, height: 26 };
  const tallPanel = { left: 0, top: 0, width: 200, height: 584 };
  const position = computePanelPosition(anchor, tallPanel, viewport);
  assert.equal(position.top, viewportMargin);
});

test("a panel is clamped inside the right and left edges", () => {
  const anchoredRight = computePanelPosition(
    { left: 790, top: 10, width: 26, height: 26 },
    panel,
    viewport,
  );
  assert.equal(anchoredRight.left, 800 - viewportMargin - panel.width);

  const anchoredLeft = computePanelPosition(
    { left: -500, top: 10, width: 26, height: 26 },
    panel,
    viewport,
  );
  assert.equal(anchoredLeft.left, viewportMargin);
});

test("a pointerdown inside the panel or its anchor keeps the popover open", () => {
  const target = { marker: "target" };
  const panelNode = stubNode([target]);
  const anchorNode = stubNode([]);
  assert.equal(isOutsideOverlay(target, panelNode, anchorNode), false);

  const anchorTarget = { marker: "anchor" };
  assert.equal(
    isOutsideOverlay(anchorTarget, stubNode([]), stubNode([anchorTarget])),
    false,
  );
});

test("a pointerdown outside both panel and anchor dismisses the popover", () => {
  const target = { marker: "outside" };
  assert.equal(isOutsideOverlay(target, stubNode([]), stubNode([])), true);
  assert.equal(isOutsideOverlay(null, stubNode([null]), stubNode()), true);
});

test("escape dismisses the popover and every other key does not", () => {
  assert.equal(isDismissKey("Escape"), true);
  assert.equal(isDismissKey("Esc"), false);
  assert.equal(isDismissKey("Enter"), false);
  assert.equal(isDismissKey(""), false);
});
