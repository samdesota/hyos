import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { createStore } from "solid-js/store";

import { renderAgentMarkdown } from "../../agent-renderer/markdown.js";
import type { WhiteboardClient } from "./client.js";
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

/** Movement (px) below which a pointer gesture counts as a click. */
const clickTolerancePx = 4;

/** How long after the last card change a save is debounced. */
const saveDebounceMs = 400;

/**
 * Builds the whiteboard surface for one board: an infinite pan/zoom canvas
 * of markdown and image cards. Dragging pans, the wheel scrolls,
 * ctrl/cmd+wheel (a trackpad pinch) zooms toward the cursor, a double-click
 * on empty canvas plants a new card, dragging a card moves it, clicking a
 * card edits its markdown inline, and pasting an image plants it as an
 * image card. Cards live at world coordinates, so they pan and zoom with
 * the board; the card list is loaded from and debounced-saved to the
 * whiteboard capability's schema, keyed by the tab's boardId (image bytes
 * go to the media table at paste time).
 */
export function createWhiteboardPage(
  client: WhiteboardClient,
): Component<Readonly<{ boardId: string }>> {
  return (props) => {
    const [viewport, setViewport] = createSignal<Viewport>(initialViewport);
    const [panning, setPanning] = createSignal(false);
    // Cards live in a keyed store: <For> keys each row by reference, so a
    // per-card store mutation re-renders only that card, and a drag frame is
    // an O(1) path set instead of copying the whole list.
    const [cards, setCards] = createStore<WhiteboardCard[]>([]);
    const [media, setMedia] = createSignal<Readonly<Record<string, string>>>(
      {},
    );
    const [editingId, setEditingId] = createSignal<string | null>(null);
    const [draggingId, setDraggingId] = createSignal<string | null>(null);
    // The board title: null until the board loads or is renamed, rendered as
    // the rename bar's placeholder ("Whiteboard").
    const [title, setTitle] = createSignal<string | null>(null);
    // The rename bar's live input text while focused, so Escape can revert.
    const [titleDraft, setTitleDraft] = createSignal<string | null>(null);

    // --- Persistence -------------------------------------------------------
    // The board loads once on mount; every card mutation calls scheduleSave,
    // debouncing a whole-list save. An explicit unsaved flag (store identity
    // is stable across keyed mutations) separates the load from real edits.
    let disposed = false;
    let unsaved = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    const saveCards = (): Promise<void> =>
      client.saveBoard(
        props.boardId,
        cards.map((card) => ({
          id: card.id,
          x: card.x,
          y: card.y,
          markdown: card.markdown,
          mediaId: card.mediaId,
        })),
      );

    const flushSave = async (): Promise<void> => {
      saveTimer = undefined;
      if (disposed || !unsaved) return;
      unsaved = false;
      try {
        await saveCards();
      } catch (error) {
        // Retry on the same debounce cadence; superseded by any newer edit.
        console.error("Whiteboard save failed; retrying", error);
        if (!disposed) scheduleSave();
      }
    };
    const scheduleSave = (): void => {
      unsaved = true;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void flushSave(), saveDebounceMs);
    };

    // Committing the rename bar writes the trimmed title; an empty title
    // clears it back to untitled. Escape (handled in the input) reverts.
    const commitTitle = (value: string): void => {
      setTitleDraft(null);
      const next = value.trim();
      if (next === (title() ?? "")) return;
      setTitle(next === "" ? null : next);
      void client
        .renameBoard(props.boardId, next)
        .catch((error) => console.error("Whiteboard rename failed", error));
    };

    onMount(() => {
      void client
        .board(props.boardId)
        .then((board) => {
          if (disposed) return;
          const restored = board.cards.map(
            ({ id, x, y, markdown, mediaId }) => ({
              id,
              x,
              y,
              markdown,
              mediaId,
            }),
          );
          setCards(restored);
          setMedia({ ...board.media });
          setTitle(board.title);
        })
        .catch((error) => console.error("Whiteboard load failed", error));
    });
    onCleanup(() => {
      disposed = true;
      // Flush synchronously on teardown so closing the tab cannot lose the
      // tail of the debounce window.
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      if (unsaved) {
        void saveCards().catch(() => undefined);
      }
    });
    let canvas: HTMLDivElement | undefined;
    // The in-flight pan: pointer id plus the last screen position, so each
    // move pans by the delta since the previous one. `moved` separates a
    // pan gesture from the click that dismisses an editor.
    let pan: {
      pointerId: number;
      lastX: number;
      lastY: number;
      moved: boolean;
    } | null = null;
    // The in-flight card drag: the dragged row's index in the keyed store
    // (captured once) plus the card's starting world and screen positions,
    // so each move maps the screen delta back through the viewport scale
    // and lands as an O(1) store path set.
    let cardDrag: {
      pointerId: number;
      cardId: string;
      cardIndex: number;
      startScreenX: number;
      startScreenY: number;
      originX: number;
      originY: number;
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
    onMount(() =>
      canvas?.addEventListener("wheel", onWheel, { passive: false }),
    );
    onCleanup(() => canvas?.removeEventListener("wheel", onWheel));

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      pan = {
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      setPanning(true);
      canvas?.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      const current = pan;
      if (current?.pointerId !== event.pointerId) return;
      const lastX = current.lastX;
      const lastY = current.lastY;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) > clickTolerancePx || Math.abs(dy) > clickTolerancePx) {
        pan = { ...current, moved: true };
      }
      setViewport((view) => panViewport(view, dx, dy));
      pan = { ...(pan ?? current), lastX: event.clientX, lastY: event.clientY };
    };
    const endPan = (event: PointerEvent): void => {
      const current = pan;
      if (current?.pointerId !== event.pointerId) return;
      pan = null;
      setPanning(false);
      if (current.moved || event.button !== 0) return;
      // A still left-click dismisses the active editor: pointerdown's
      // preventDefault blocks the textarea's blur, so commit explicitly.
      const activeId = editingId();
      if (activeId !== null) commitEdit(activeId, editor?.value ?? "");
    };

    // Double-click on empty canvas plants a card and opens its editor.
    // Double-clicks on a card bubble here too, so cards are excluded.
    const onCanvasDblClick = (event: MouseEvent): void => {
      if (event.button !== 0 || !canvas) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".whiteboard-card")
      )
        return;
      const activeId = editingId();
      if (activeId !== null) commitEdit(activeId, editor?.value ?? "");
      const bounds = canvas.getBoundingClientRect();
      const world = screenToWorld(
        viewport(),
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
      const id = crypto.randomUUID();
      setCards(
        addWhiteboardCard(cards, {
          id,
          x: world.x,
          y: world.y,
          markdown: "",
          mediaId: null,
        }),
      );
      scheduleSave();
      setEditingId(id);
    };

    // Committing an edit rewrites the card, and an empty commit removes it —
    // blank cards never linger on the board.
    const commitEdit = (id: string, markdown: string): void => {
      setEditingId(null);
      if (isBlankCardMarkdown(markdown)) {
        setCards(removeWhiteboardCard(cards, id));
      } else {
        setCards(updateWhiteboardCard(cards, id, markdown));
      }
      scheduleSave();
    };

    // Pasting an image plants it as an image card at the center of the
    // viewport. The bytes are written to the media table first (as a data
    // URL) so the card save that follows always has its image; deleting the
    // card later cleans the media up on the next save. Text pastes are left
    // to the active editor — only image payloads are captured here.
    const onDocumentPaste = (event: ClipboardEvent): void => {
      if (editingId() !== null || !canvas) return;
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) =>
        entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      const mime = item!.type;
      const bounds = canvas.getBoundingClientRect();
      const world = screenToWorld(
        viewport(),
        bounds.width / 2,
        bounds.height / 2,
      );
      void file.arrayBuffer().then((buffer: ArrayBuffer) => {
        // btoa in 32k chunks: spread limits keep the argument list bounded.
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let start = 0; start < bytes.length; start += 0x8000) {
          binary += String.fromCharCode(
            ...bytes.subarray(start, start + 0x8000),
          );
        }
        const dataUrl = `data:${mime};base64,${btoa(binary)}`;
        const cardId = crypto.randomUUID();
        const mediaId = crypto.randomUUID();
        void client
          .saveBoardMedia(props.boardId, mediaId, dataUrl)
          .then(() => {
            if (disposed) return;
            setMedia((current) => ({ ...current, [mediaId]: dataUrl }));
            setCards(
              addWhiteboardCard(cards, {
                id: cardId,
                x: world.x,
                y: world.y,
                markdown: "",
                mediaId,
              }),
            );
            scheduleSave();
          })
          .catch((error) =>
            console.error("Whiteboard image paste failed", error),
          );
      });
    };
    onMount(() => document.addEventListener("paste", onDocumentPaste));
    onCleanup(() => document.removeEventListener("paste", onDocumentPaste));

    const onCardPointerDown =
      (card: WhiteboardCard) => (event: PointerEvent) => {
        if (event.button !== 0) return;
        // A card being edited must not drag; its textarea needs caret
        // placement and selection, so hands off entirely.
        if (
          editingId() === card.id ||
          event.target instanceof HTMLTextAreaElement
        ) {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        // An open editor elsewhere blocks the blur with preventDefault, so
        // commit it before this card can become the editing target.
        const activeId = editingId();
        if (activeId !== null) commitEdit(activeId, editor?.value ?? "");
        const cardIndex = cards.findIndex((entry) => entry.id === card.id);
        if (cardIndex === -1) return;
        cardDrag = {
          pointerId: event.pointerId,
          cardId: card.id,
          cardIndex,
          startScreenX: event.clientX,
          startScreenY: event.clientY,
          originX: card.x,
          originY: card.y,
          moved: false,
        };
        setDraggingId(card.id);
        const element = event.currentTarget;
        if (element instanceof HTMLElement) {
          element.setPointerCapture(event.pointerId);
        }
      };
    const onCardPointerMove =
      (card: WhiteboardCard) => (event: PointerEvent) => {
        const current = cardDrag;
        if (
          current?.pointerId !== event.pointerId ||
          current.cardId !== card.id
        )
          return;
        const dx = event.clientX - current.startScreenX;
        const dy = event.clientY - current.startScreenY;
        let moved = current.moved;
        if (
          Math.abs(dx) > clickTolerancePx ||
          Math.abs(dy) > clickTolerancePx
        ) {
          cardDrag = { ...current, moved: true };
          moved = true;
        }
        if (!moved) return;
        // Screen deltas divide by zoom to become world deltas. Keyed store
        // path sets touch only this row: <For> re-renders just this card and
        // the whole-list copy per frame is gone.
        const index = current.cardIndex;
        if (index >= cards.length || cards[index]!.id !== card.id) return;
        const scale = viewport().scale;
        const x = current.originX + dx / scale;
        const y = current.originY + dy / scale;
        setCards(index, { x, y });
        scheduleSave();
      };
    const onCardPointerUp = (card: WhiteboardCard) => (event: PointerEvent) => {
      const current = cardDrag;
      if (current?.pointerId !== event.pointerId || current.cardId !== card.id)
        return;
      cardDrag = null;
      setDraggingId(null);
      // A still press is a click: open this card's editor. Image cards have
      // no markdown editor — a blank commit would delete the image.
      if (!current.moved && editingId() === null && card.mediaId === null) {
        setEditingId(card.id);
      }
    };
    const onCardPointerCancel = (event: PointerEvent) => {
      if (cardDrag?.pointerId !== event.pointerId) return;
      cardDrag = null;
      setDraggingId(null);
    };

    const percent = () => `${Math.round(viewport().scale * 100)}%`;

    return (
      <section class="whiteboard-page" aria-label="Whiteboard">
        <div class="whiteboard-title-bar">
          <input
            class="whiteboard-title-input"
            type="text"
            value={titleDraft() ?? title() ?? ""}
            placeholder="Whiteboard"
            aria-label="Board title"
            spellcheck={false}
            onInput={(event) => setTitleDraft(event.currentTarget.value)}
            onFocus={(event) => setTitleDraft(event.currentTarget.value)}
            onBlur={(event) => commitTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                // Revert to the stored title; blur then commits the restored
                // value, which the equality guard turns into a no-op.
                event.currentTarget.value = title() ?? "";
                setTitleDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <div
          ref={canvas}
          class="whiteboard-canvas"
          classList={{ panning: panning() }}
          data-board-id={props.boardId}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onDblClick={onCanvasDblClick}
        >
          <div
            class="whiteboard-world"
            style={{
              transform: `translate(${viewport().x}px, ${viewport().y}px) scale(${viewport().scale})`,
            }}
          >
            <For each={cards}>
              {(card) => (
                <div
                  class="whiteboard-card"
                  classList={{
                    editing: editingId() === card.id,
                    dragging: draggingId() === card.id,
                  }}
                  style={{ left: `${card.x}px`, top: `${card.y}px` }}
                  onPointerDown={onCardPointerDown(card)}
                  onPointerMove={onCardPointerMove(card)}
                  onPointerUp={onCardPointerUp(card)}
                  onPointerCancel={onCardPointerCancel}
                >
                  <Show
                    when={card.mediaId === null ? false : media()[card.mediaId]}
                    fallback={
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
                    }
                  >
                    {(dataUrl) => (
                      <img
                        class="whiteboard-card-image"
                        src={dataUrl()}
                        alt="Pasted image"
                        draggable={false}
                      />
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
        <output class="whiteboard-zoom">{percent()}</output>
        <Show when={cards.length === 0}>
          <p class="whiteboard-hint">
            Double-click to add a card, or paste an image
          </p>
        </Show>
        <Show when={panning()}>
          <span class="visually-hidden" role="status">
            Panning whiteboard
          </span>
        </Show>
      </section>
    );
  };
}
