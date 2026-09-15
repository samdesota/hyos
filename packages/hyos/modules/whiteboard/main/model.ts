import { hydb, id, index, number, text, timestamp } from "@hyos/hydb";

// Boards are identified up front by the tab's uuid, so the row is created
// lazily on first save; a board with no row simply has no cards yet.
export const whiteboardBoards = hydb.table(
  "hyos_whiteboard_boards",
  {
    id: id().primaryKey(),
    // Nullable: boards are created lazily by card saves; the title is set
    // by the rename bar and absent until the user names the board.
    title: text(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_whiteboard_boards_updated_idx").on(columns.updatedAt),
  ],
);

// hydb has no blob type (Uint8Array silently corrupts), so images live as
// data-URL text in this dedicated table, referenced by card mediaId; the
// data URL carries the mime type with the bytes.
// Declared before the cards table so their forward reference is safe.
export const whiteboardBoardMedia = hydb.table(
  "hyos_whiteboard_board_media",
  {
    id: id().primaryKey(),
    boardId: id()
      .notNull()
      .references(() => whiteboardBoards.id),
    data: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_whiteboard_board_media_board_idx").on(
      columns.boardId,
      columns.id,
    ),
  ],
);

export const whiteboardBoardCards = hydb.table(
  "hyos_whiteboard_board_cards",
  {
    id: id().primaryKey(),
    boardId: id()
      .notNull()
      .references(() => whiteboardBoards.id),
    // World coordinates of the card's top-left corner.
    x: number().notNull(),
    y: number().notNull(),
    markdown: text().notNull(),
    // Set once image cards exist: a reference into whiteboardBoardMedia.
    mediaId: id().references(() => whiteboardBoardMedia.id),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_whiteboard_board_cards_board_idx").on(
      columns.boardId,
      columns.id,
    ),
  ],
);

export const whiteboardSchema = hydb.schema({
  whiteboardBoards,
  whiteboardBoardCards,
  whiteboardBoardMedia,
});
