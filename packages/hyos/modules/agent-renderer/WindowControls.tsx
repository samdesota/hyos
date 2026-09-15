import { onCleanup, createSignal, type Component } from "solid-js";

import type { WindowControlsClient } from "./client.js";

/**
 * Arc-style window controls: a collapsed cluster of dim dots that expands
 * into the familiar macOS traffic lights on hover (or keyboard focus) and
 * invokes the `window-controls` capability on click.
 *
 * On pointer hover the expanded dots crossfade into the *native* traffic
 * lights, which the main process reveals via `setButtonsVisible(true)` —
 * so the real macOS buttons (long-press menus, option-click zoom) take
 * over exactly where the custom dots animated in. The native buttons sit
 * above the renderer and swallow pointer events, so concealment watches
 * window-level `pointermove`: any move landing outside the controls region
 * (the only events we can still see) hides them again.
 */
export const WindowControls: Component<{ controls: WindowControlsClient }> = (
  props,
) => {
  const [native, setNative] = createSignal(false);
  let container: HTMLDivElement | undefined;

  const setButtons = (visible: boolean): void => {
    void props.controls.setButtonsVisible(visible).catch(() => undefined);
  };

  const reveal = (): void => {
    if (native()) return;
    setNative(true);
    setButtons(true);
    window.addEventListener("pointermove", onPointerMove);
  };

  const conceal = (): void => {
    if (!native()) return;
    setNative(false);
    setButtons(false);
    window.removeEventListener("pointermove", onPointerMove);
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
