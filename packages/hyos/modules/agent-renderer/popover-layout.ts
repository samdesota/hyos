/**
 * Pure decision logic shared by the Popover primitive (and reused by tests).
 * No DOM dependencies beyond structural types so it can be exercised in the
 * plain node test suite.
 */

export const viewportMargin = 8;

export type Rect = { left: number; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };
export type PanelPosition = { left: number; top: number; flipped: boolean };

/**
 * Position a panel below the anchor, flipping above it when it would overflow
 * the viewport bottom, then clamping both axes so the panel stays inside the
 * viewport with an 8px margin.
 */
export const computePanelPosition = (
  anchorRect: Rect,
  panelRect: Rect,
  viewport: Viewport,
): PanelPosition => {
  let flipped = false;
  let left = anchorRect.left;
  let top = anchorRect.top + anchorRect.height + viewportMargin;
  if (top + panelRect.height > viewport.height - viewportMargin) {
    top = anchorRect.top - panelRect.height - viewportMargin;
    flipped = true;
  }
  top = Math.max(
    viewportMargin,
    Math.min(top, viewport.height - viewportMargin - panelRect.height),
  );
  left = Math.max(
    viewportMargin,
    Math.min(left, viewport.width - viewportMargin - panelRect.width),
  );
  return { left: Math.round(left), top: Math.round(top), flipped };
};

/** Structural node shape used for containment checks (test-stubbable). */
export interface OverlayNode {
  contains(node: unknown): boolean;
}

/**
 * Click-outside decision: a pointerdown outside both the panel and its
 * anchor dismisses the popover; inside either keeps it open.
 */
export const isOutsideOverlay = (
  target: unknown,
  panel: OverlayNode | null | undefined,
  anchor: OverlayNode | null | undefined,
): boolean => {
  if (!(target instanceof Object)) return true;
  if (panel?.contains(target)) return false;
  if (anchor?.contains(target)) return false;
  return true;
};

/** Escape dismisses an overlay; every other key leaves it alone. */
export const isDismissKey = (key: string): boolean => key === "Escape";
