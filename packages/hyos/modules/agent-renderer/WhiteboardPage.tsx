import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import {
  clampViewportScale,
  initialViewport,
  panViewport,
  zoomViewport,
  type Viewport,
} from "./whiteboard-viewport.js";

export type WhiteboardPageProps = Readonly<{
  boardId: string;
}>;

/**
 * The whiteboard surface for one board: an infinite pan/zoom canvas.
 * Dragging pans, the wheel scrolls, and ctrl/cmd+wheel (a trackpad pinch)
 * zooms toward the cursor. The board is identified by id only, so the
 * page never owns board state; the viewport is presentation-local.
 */
export const WhiteboardPage: Component<WhiteboardPageProps> = (props) => {
  const [viewport, setViewport] = createSignal<Viewport>(initialViewport);
  const [panning, setPanning] = createSignal(false);
  let canvas: HTMLDivElement | undefined;
  // The in-flight drag: pointer id plus the last screen position, so each
  // move pans by the delta since the previous one.
  let drag: { pointerId: number; lastX: number; lastY: number } | null = null;

  const onWheel = (event: WheelEvent): void => {
    // The canvas owns scrolling: without this the app shell scrolls too.
    event.preventDefault();
    const bounds = canvas?.getBoundingClientRect();
    if (!bounds) return;
    const screenX = event.clientX - bounds.left;
    const screenY = event.clientY - bounds.top;
    if (event.ctrlKey || event.metaKey) {
      // Chromium pinch gestures arrive as ctrl+wheel; the exponential
      // factor keeps small trackpad deltas smooth.
      const next = clampViewportScale(
        viewport().scale * Math.exp(-event.deltaY * 0.01),
      );
      setViewport((view) => zoomViewport(view, next, screenX, screenY));
    } else {
      setViewport((view) => panViewport(view, -event.deltaX, -event.deltaY));
    }
  };

  // Attached non-passively so preventDefault can stop shell scrolling.
  onMount(() => canvas?.addEventListener("wheel", onWheel, { passive: false }));
  onCleanup(() => canvas?.removeEventListener("wheel", onWheel));

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    setPanning(true);
    canvas?.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    const current = drag;
    if (current?.pointerId !== event.pointerId) return;
    const lastX = current.lastX;
    const lastY = current.lastY;
    setViewport((view) =>
      panViewport(view, event.clientX - lastX, event.clientY - lastY),
    );
    drag = { ...current, lastX: event.clientX, lastY: event.clientY };
  };
  const endPan = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    setPanning(false);
  };

  const percent = () => `${Math.round(viewport().scale * 100)}%`;

  return (
    <section class="whiteboard-page" aria-label="Whiteboard">
      <div
        ref={canvas}
        class="whiteboard-canvas"
        classList={{ panning: panning() }}
        data-board-id={props.boardId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          class="whiteboard-world"
          style={{
            transform: `translate(${viewport().x}px, ${viewport().y}px) scale(${viewport().scale})`,
          }}
        />
      </div>
      <output class="whiteboard-zoom">{percent()}</output>
      <Show when={panning()}>
        <span class="visually-hidden" role="status">
          Panning whiteboard
        </span>
      </Show>
    </section>
  );
};
