import { defineRemoteCapability, remoteMethod } from "./contract.js";

/**
 * One card on a whiteboard: a markdown note or an image (via mediaId)
 * placed at world coordinates, so it pans and zooms with the canvas.
 */
export type WhiteboardBoardCard = Readonly<{
  id: string;
  x: number;
  y: number;
  markdown: string;
  /** Reference into the board's media table once image cards exist. */
  mediaId: string | null;
}>;

/** A board's full card list plus its media (data URLs), loaded or saved as one unit. */
export type WhiteboardBoard = Readonly<{
  boardId: string;
  /** Nullable: boards saved before titles existed (or never titled) read null. */
  title: string | null;
  cards: readonly WhiteboardBoardCard[];
  /** Media rows keyed by id; values are image data URLs. */
  media: Readonly<Record<string, string>>;
}>;

export const whiteboardCapability = defineRemoteCapability({
  id: "whiteboard",
  version: 1,
  methods: {
    /** A board's cards; a board that was never saved reads as empty. */
    board: remoteMethod<readonly [boardId: string], WhiteboardBoard>(),
    /** Replace a board's whole card list with the given one. */
    saveBoard: remoteMethod<
      readonly [boardId: string, cards: readonly WhiteboardBoardCard[]],
      void
    >(),
    /** Set a board's title; a board row is created if none exists yet. */
    renameBoard: remoteMethod<
      readonly [boardId: string, title: string],
      void
    >(),
    /** Store one image (a data URL) referenced by a card's mediaId. */
    saveBoardMedia: remoteMethod<
      readonly [boardId: string, mediaId: string, data: string],
      void
    >(),
  },
  events: {},
});
