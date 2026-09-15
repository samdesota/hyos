import assert from "node:assert/strict";
import test from "node:test";

import {
  clampViewportScale,
  initialViewport,
  maxViewportScale,
  minViewportScale,
  panViewport,
  screenToWorld,
  zoomViewport,
} from "./whiteboard-viewport.js";

const nearlyEqual = (left: number, right: number): void =>
  assert.ok(Math.abs(left - right) < 1e-9, `${left} ≉ ${right}`);

test("a fresh board shows the identity viewport at 100% zoom", () => {
  assert.deepEqual(initialViewport, { x: 0, y: 0, scale: 1 });
});

test("panning shifts the origin by the screen delta and keeps zoom", () => {
  const panned = panViewport(initialViewport, 40, -15);
  assert.deepEqual(panned, { x: 40, y: -15, scale: 1 });
  // Panning is additive and zoom-independent.
  assert.deepEqual(panViewport(panned, -40, 15), initialViewport);
  assert.equal(panViewport({ x: 0, y: 0, scale: 3 }, 10, 10).scale, 3);
});

test("zooming pins the world point under the cursor", () => {
  const viewport = { x: 120, y: -60, scale: 1.5 };
  const screen = { x: 300, y: 200 };
  const world = screenToWorld(viewport, screen.x, screen.y);
  const zoomed = zoomViewport(viewport, 3, screen.x, screen.y);
  assert.equal(zoomed.scale, 3);
  // Same world point, same screen point.
  const round = screenToWorld(zoomed, screen.x, screen.y);
  nearlyEqual(round.x, world.x);
  nearlyEqual(round.y, world.y);
});

test("zooming at the screen origin pins the world origin there", () => {
  // The world point at the screen origin is (-40, -20); zooming keeps it
  // there, so the origin itself moves under the transform.
  const zoomed = zoomViewport({ x: 80, y: 40, scale: 2 }, 4, 0, 0);
  assert.deepEqual(zoomed, { x: 160, y: 80, scale: 4 });
  const world = screenToWorld(zoomed, 0, 0);
  nearlyEqual(world.x, -40);
  nearlyEqual(world.y, -20);
});

test("zoom clamps to the bounds instead of blowing past them", () => {
  assert.equal(clampViewportScale(0.01), minViewportScale);
  assert.equal(clampViewportScale(99), maxViewportScale);
  assert.equal(clampViewportScale(1), 1);
  const zoomedOut = zoomViewport(initialViewport, 0.001, 500, 300);
  assert.equal(zoomedOut.scale, minViewportScale);
  // Clamping still anchors the pivot: the world point under the cursor is
  // the one the identity viewport put there.
  const world = screenToWorld(zoomedOut, 500, 300);
  nearlyEqual(world.x, 500);
  nearlyEqual(world.y, 300);
});

test("zooming out at a cursor keeps the cursor's world point put", () => {
  const worldBefore = screenToWorld(initialViewport, 200, 100);
  const zoomed = zoomViewport(initialViewport, 0.5, 200, 100);
  const worldAfter = screenToWorld(zoomed, 200, 100);
  nearlyEqual(worldAfter.x, worldBefore.x);
  nearlyEqual(worldAfter.y, worldBefore.y);
});
