import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

import { bindOverlayLifecycle } from "./overlay-lifecycle.js";
import {
  computePanelPosition,
  isDismissKey,
  isOutsideOverlay,
  type PanelPosition,
} from "./popover-layout.js";

/**
 * Shared floating-panel primitive next to Modal: a portal-mounted panel
 * anchored to an element, with click-outside and Escape to close, the shared
 * modal-overlay lifecycle, and viewport clamping — the panel flips above the
 * anchor when it would overflow the bottom and is clamped inside the
 * viewport with an 8px margin on both axes. Content is supplied as children;
 * styling hooks: `.popover-panel` plus an optional extra `class`.
 *
 * Set `overBrowser` when the panel can overlap an embedded browser view:
 * while open, the native UI surface is raised above the browser views.
 */
export const Popover: Component<{
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null | undefined;
  label: string;
  class?: string;
  overBrowser?: boolean;
  width?: number;
  children: JSX.Element;
}> = (props) => {
  bindOverlayLifecycle(
    () => props.open,
    () => !!props.overBrowser,
  );

  const [position, setPosition] = createSignal<{
    left: number;
    top: number;
  } | null>(null);
  let panel: HTMLDivElement | undefined;

  // Position (and re-position, e.g. when content size changes) relative to
  // the anchor, flipping above and clamping so the panel never overflows
  // the viewport.
  const layout = (): void => {
    if (!props.anchor || !panel) return;
    const anchorRect = props.anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const { left, top } = computePanelPosition(anchorRect, panelRect, {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    setPosition({ left, top });
  };

  createEffect(() => {
    if (!props.open) {
      setPosition(null);
      return;
    }
    // Two frames: first lets the portal mount so the panel has a size,
    // then any content-driven growth (targets loading, etc.) re-clamps.
    const frame = requestAnimationFrame(() => {
      layout();
      requestAnimationFrame(layout);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  createEffect(() => {
    if (!props.open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!isOutsideOverlay(event.target, panel, props.anchor)) return;
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isDismissKey(event.key)) props.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={panel}
          class={props.class ? `popover-panel ${props.class}` : "popover-panel"}
          role="dialog"
          aria-label={props.label}
          data-browser-overlay
          style={{
            position: "fixed",
            left: `${position()?.left ?? 0}px`,
            top: `${position()?.top ?? 0}px`,
            ...(props.width ? { width: `${props.width}px` } : {}),
            // Hidden until measured so the panel never flashes unclamped.
            visibility: position() ? "visible" : "hidden",
          }}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
};
