import { createEffect, onCleanup } from "solid-js";

import { setModalOverlayActive } from "../browser-view/modal-overlay.js";

/**
 * Shared overlay lifecycle for floating UI (Modal, Popover): while `open` and
 * `overBrowser` hold, the native UI view is raised above embedded browser
 * views; the flag is always dropped on close or unmount.
 */
export const bindOverlayLifecycle = (
  open: () => boolean,
  overBrowser: () => boolean,
): void => {
  createEffect(() => setModalOverlayActive(open() && overBrowser()));
  onCleanup(() => setModalOverlayActive(false));
};
