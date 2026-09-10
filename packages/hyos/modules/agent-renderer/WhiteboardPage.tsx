import { type Component } from "solid-js";

export type WhiteboardPageProps = Readonly<{
  boardId: string;
}>;

/**
 * The whiteboard surface for one board. For now a placeholder canvas —
 * pan/zoom and cards land in later iterations; the board is identified by
 * id only, so the page never owns board state.
 */
export const WhiteboardPage: Component<WhiteboardPageProps> = (props) => (
  <section class="whiteboard-page" aria-label="Whiteboard">
    <div class="whiteboard-canvas" data-board-id={props.boardId} />
  </section>
);
