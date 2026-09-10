import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import { renderAgentMarkdown } from "./markdown.js";
import {
  addWhiteboardCard,
  isBlankCardMarkdown,
  removeWhiteboardCard,
  updateWhiteboardCard,
  type WhiteboardCard,
} from "./whiteboard-cards.js";
import {
  clampViewportScale,
  initialViewport,
  panViewport,
  screenToWorld,
  zoomViewport,
  type Viewport,
} from "./whiteboard-viewport.js";

export type WhiteboardPageProps = Readonly<{
  boardId: string;
}>;

/** Movement (px) below which a pointer gesture counts as a click. */
const clickTolerancePx = 4;

/**
 * The whiteboard surface for one board: an infinite pan/zoom canvas of
 * markdown cards. Dragging pans, the wheel scrolls, ctrl/cmd+wheel (a
 * trackpad pinch) zooms toward the cursor, a click on empty canvas plants
 * a new card, and clicking a card edits its markdown inline. Cards live
 * at world coordinates, so they pan and zoom with the board; the board is
 * identified by id only and persistence arrives with the agent
 * capability, so the card list is presentation-local for now.
 */
export const WhiteboardPage: Component<WhiteboardPageProps> = (props) => {
  const [viewport, setViewport] = createSignal<Viewport>(initialViewport);
  const [panning, setPanning] = createSignal(false);
  const [cards, setCards] = createSignal<readonly WhiteboardCard[]>([]);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  let canvas: HTMLDivElement | undefined;
  // The in-flight drag: pointer id plus the last screen position, so each
  // move pans by the delta since the previous one. `moved` separates a
  // pan gesture from a click that plants a card.
  let drag: {
    pointerId: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;
  // Textarea for the card being edited, focused when editing starts.
  let editor: HTMLTextAreaElement | undefined;

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
      moved: false,
    };
    setPanning(true);
    canvas?.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    const current = drag;
    if (current?.pointerId !== event.pointerId) return;
    const lastX = current.lastX;
    const lastY = current.lastY;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (Math.abs(dx) > clickTolerancePx || Math.abs(dy) > clickTolerancePx) {
      drag = { ...current, moved: true };
    }
    setViewport((view) => panViewport(view, dx, dy));
    drag = { ...(drag ?? current), lastX: event.clientX, lastY: event.clientY };
  };
  // `plant` is true only for pointerup: a still left-click on empty
  // canvas commits any open editor (pointerdown's preventDefault blocks
  // the textarea's blur, so commit explicitly) and plants a new card
  // under the cursor.
  const endPan = (event: PointerEvent, plant = false): void => {
    const current = drag;
    if (current?.pointerId !== event.pointerId) return;
    drag = null;
    setPanning(false);
    if (!plant || current.moved || event.button !== 0 || !canvas) return;
    const activeId = editingId();
    if (activeId !== null) commitEdit(activeId, editor?.value ?? "");
    const bounds = canvas.getBoundingClientRect();
    const world = screenToWorld(
      viewport(),
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    const id = crypto.randomUUID();
    setCards((list) =>
      addWhiteboardCard(list, { id, x: world.x, y: world.y, markdown: "" }),
    );
    setEditingId(id);
  };

  // Committing an edit rewrites the card, and an empty commit removes it —
  // blank cards never linger on the board.
  const commitEdit = (id: string, markdown: string): void => {
    setEditingId(null);
    if (isBlankCardMarkdown(markdown)) {
      setCards((list) => removeWhiteboardCard(list, id));
    } else {
      setCards((list) => updateWhiteboardCard(list, id, markdown));
    }
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
        onPointerUp={(event) => endPan(event, true)}
        onPointerCancel={endPan}
      >
        <div
          class="whiteboard-world"
          style={{
            transform: `translate(${viewport().x}px, ${viewport().y}px) scale(${viewport().scale})`,
          }}
        >
          <For each={cards()}>
            {(card) => (
              <div
                class="whiteboard-card"
                classList={{ editing: editingId() === card.id }}
                style={{ left: `${card.x}px`, top: `${card.y}px` }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (editingId() === null) setEditingId(card.id);
                }}
              >
                <Show
                  when={editingId() === card.id}
                  fallback={
                    <div
                      class="whiteboard-card-body"
                      innerHTML={renderAgentMarkdown(card.markdown)}
                    />
                  }
                >
                  <textarea
                    ref={(el) => {
                      editor = el;
                      queueMicrotask(() => el.focus());
                    }}
                    class="whiteboard-card-editor"
                    value={card.markdown}
                    placeholder="Write markdown…"
                    aria-label="Card markdown"
                    onBlur={(event) =>
                      commitEdit(card.id, event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        commitEdit(card.id, event.currentTarget.value);
                      }
                    }}
                  />
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
      <output class="whiteboard-zoom">{percent()}</output>
      <Show when={cards().length === 0}>
        <p class="whiteboard-hint">Click anywhere to add a card</p>
      </Show>
      <Show when={panning()}>
        <span class="visually-hidden" role="status">
          Panning whiteboard
        </span>
      </Show>
    </section>
  );
};
