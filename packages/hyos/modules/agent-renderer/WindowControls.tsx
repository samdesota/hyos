import { onCleanup, createSignal, type Component } from "solid-js";

import type { WindowControlsClient } from "./client.js";

/**
 * Arc-style window controls: a collapsed cluster of dim dots that expands
 * into the familiar macOS traffic lights on hover (or keyboard focus) and
 * invokes the `window-controls` capability on click.
 *
 * On pointer hover the expanded dots crossfade into the *native* traffic
 * lights, which the main process reveals via `setButtonsVisible(true)` —
 * but only once the expansion animation has finished (`transitionend` on
 * the cluster's `gap` transition, with a fallback timer), so the ghosts
 * settle onto the native slot before the real macOS buttons (long-press
 * menus, option-click zoom) take over. The native buttons sit
 * above the renderer and swallow pointer events, so concealment watches
 * window-level `pointermove`: any move landing outside the controls region
 * (the only events we can still see) hides them again.
 */
const REVEAL_FALLBACK_MS = 250;

export const WindowControls: Component<{ controls: WindowControlsClient }> = (
  props,
) => {
  const [native, setNative] = createSignal(false);
  let container: HTMLDivElement | undefined;
  let pendingReveal = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const setButtons = (visible: boolean): void => {
    void props.controls.setButtonsVisible(visible).catch(() => undefined);
  };

  const cancelPendingReveal = (): void => {
    pendingReveal = false;
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    container?.removeEventListener("transitionend", onTransitionEnd);
  };

  const revealNow = (): void => {
    cancelPendingReveal();
    if (native()) return;
    setNative(true);
    setButtons(true);
    window.addEventListener("pointermove", onPointerMove);
  };

  // Wait for the expansion animation (the `gap` transition on the cluster)
  // to finish before the native lights take over.
  const reveal = (): void => {
    if (native() || pendingReveal) return;
    pendingReveal = true;
    container?.addEventListener("transitionend", onTransitionEnd);
    fallbackTimer = setTimeout(revealNow, REVEAL_FALLBACK_MS);
  };

  const onTransitionEnd = (event: TransitionEvent): void => {
    // Only the container's `gap` transition marks the end of the expansion;
    // guard against pointer leaving mid-animation.
    if (event.target !== container || event.propertyName !== "gap") return;
    if (!container?.matches(":hover, :focus-within")) {
      cancelPendingReveal();
      return;
    }
    revealNow();
  };

  const conceal = (): void => {
    cancelPendingReveal();
    if (!native()) return;
    setNative(false);
    setButtons(false);
    window.removeEventListener("pointermove", onPointerMove);
  };

  // Pointer left before the animation finished — never reveal the native
  // lights and let the cluster collapse back.
  const onPointerLeave = (): void => {
    if (!native()) cancelPendingReveal();
  };

  // The native lights intercept events over their own pixels, so any
  // pointermove the DOM still receives outside the controls region means
  // the pointer has moved on — hide the native lights again.
  const onPointerMove = (event: PointerEvent): void => {
    const element = container;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const inside =
      event.clientX >= bounds.left - 4 &&
      event.clientX <= bounds.right + 4 &&
      event.clientY >= bounds.top - 4 &&
      event.clientY <= bounds.bottom + 4;
    if (!inside) conceal();
  };

  onCleanup(() => {
    cancelPendingReveal();
    setButtons(false);
    window.removeEventListener("pointermove", onPointerMove);
  });

  return (
    <div
      ref={container}
      class="win-controls"
      classList={{ native: native() }}
      role="group"
      aria-label="Window controls"
      onPointerEnter={reveal}
      onPointerLeave={onPointerLeave}
    >
      <button
        class="win-dot win-dot-close"
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={() => void props.controls.close()}
      />
      <button
        class="win-dot win-dot-minimize"
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void props.controls.minimize()}
      />
      <button
        class="win-dot win-dot-maximize"
        type="button"
        aria-label="Zoom window"
        title="Zoom"
        onClick={() => void props.controls.toggleMaximize()}
      />
    </div>
  );
};
