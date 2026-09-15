import { createSignal } from "solid-js";

/**
 * Shared signal for "modal overlay mode": while true, UI that can overlap
 * embedded browser views (modals, overlays) is raised above them natively.
 * UI components opt in via `Modal`'s `overBrowser` prop; the `BrowserView`
 * measure loop forwards changes to the main-process browser host
 * (`browser.setModalOverlay`), which re-orders the window's native views.
 */
const [modalOverlayActive, setModalOverlayActive] = createSignal(false);

export { modalOverlayActive, setModalOverlayActive };
