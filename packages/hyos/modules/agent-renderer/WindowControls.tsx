import { type Component } from "solid-js";

import type { WindowControlsClient } from "./client.js";

/**
 * Arc-style window controls: a collapsed cluster of dim dots that expands
 * into the familiar macOS traffic lights on hover (or keyboard focus) and
 * invokes the `window-controls` capability on click. Replaces the native
 * buttons hidden by the main process.
 */
export const WindowControls: Component<{ controls: WindowControlsClient }> = (
  props,
) => (
  <div class="win-controls" role="group" aria-label="Window controls">
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
