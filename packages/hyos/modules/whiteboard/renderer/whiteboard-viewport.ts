/**
 * Pan/zoom model for the whiteboard's infinite canvas. The viewport is a
 * 2D transform from world coordinates (where cards will live) to screen
 * pixels: `screen = world * scale + (x, y)`. All inputs are in screen
 * space, so panning by pixels is zoom-independent and zooming pivots
 * around the pointer without any element measuring.
 */
export type Viewport = Readonly<{ x: number; y: number; scale: number }>;

/** Zoom bounds, matching the mermaid diagram viewer's limits. */
export const minViewportScale = 0.25;
export const maxViewportScale = 5;

/** The viewport a fresh board shows: identity transform, 100% zoom. */
export const initialViewport: Viewport = { x: 0, y: 0, scale: 1 };

export function clampViewportScale(scale: number): number {
  return Math.min(maxViewportScale, Math.max(minViewportScale, scale));
}

/** Screen point → world point under it, the inverse of the transform. */
export function screenToWorld(
  viewport: Viewport,
  screenX: number,
  screenY: number,
): Readonly<{ x: number; y: number }> {
  const { scale } = viewport;
  return {
    x: (screenX - viewport.x) / scale,
    y: (screenY - viewport.y) / scale,
  };
}

/** Pan by a screen-space delta; pixels are unaffected by zoom. */
export function panViewport(
  viewport: Viewport,
  dx: number,
  dy: number,
): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/**
 * Zoom to `scale` (clamped to bounds) while keeping the world point under
 * the given screen position pinned — zooming toward the cursor, not the
 * canvas origin.
 */
export function zoomViewport(
  viewport: Viewport,
  scale: number,
  screenX: number,
  screenY: number,
): Viewport {
  const clamped = clampViewportScale(scale);
  const world = screenToWorld(viewport, screenX, screenY);
  return {
    scale: clamped,
    x: screenX - world.x * clamped,
    y: screenY - world.y * clamped,
  };
}
