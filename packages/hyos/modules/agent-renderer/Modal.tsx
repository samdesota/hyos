import { Show, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * Reusable portal-based modal: fixed overlay with blurred backdrop,
 * a `role="dialog"` panel, Escape-to-close, and click-outside-to-close.
 * Content is supplied as children; styling hooks: `.modal-panel` plus
 * an optional extra `class`.
 */
export const Modal: Component<{
  open: boolean;
  onClose: () => void;
  label: string;
  class?: string;
  children: JSX.Element;
}> = (props) => (
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
