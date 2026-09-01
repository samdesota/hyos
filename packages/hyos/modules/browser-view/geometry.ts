import type { BrowserBounds } from "../../capabilities/browser.js";

export function boundsOf(element: Element): BrowserBounds {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return (
    Math.round(left.x) === Math.round(right.x) &&
    Math.round(left.y) === Math.round(right.y) &&
    Math.round(left.width) === Math.round(right.width) &&
    Math.round(left.height) === Math.round(right.height)
  );
}

export function isElementVisible(
  element: Element,
  bounds: BrowserBounds,
): boolean {
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0 &&
    bounds.x < window.innerWidth &&
    bounds.y < window.innerHeight
  );
}
