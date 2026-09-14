import { createEffect, onCleanup, Show, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { setModalOverlayActive } from "../browser-view/modal-overlay.js";

/**
 * Reusable portal-based modal: fixed overlay with blurred backdrop,
 * a `role="dialog"` panel, Escape-to-close, and click-outside-to-close.
 * Content is supplied as children; styling hooks: `.modal-panel` plus
 * an optional extra `class`.
 *
 * Set `overBrowser` when the modal can overlap an embedded browser view:
 * while open, the native UI surface is raised above the browser views so
 * the modal composites over (and blocks input to) embedded web content.
 */
export const Modal: Component<{
  open: boolean;
  onClose: () => void;
  label: string;
  class?: string;
  overBrowser?: boolean;
  children: JSX.Element;
}> = (props) => {
  createEffect(() => {
    setModalOverlayActive(props.open && !!props.overBrowser);
  });
  onCleanup(() => setModalOverlayActive(false));
  return (
    <Show when={props.open}>
      <Portal>
      <div
        class="modal-overlay"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div
          class={props.class ? `modal-panel ${props.class}` : "modal-panel"}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          {props.children}
        </div>
      </div>
    </Portal>
    </Show>
  );
};
