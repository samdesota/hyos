import { hydb, type Database } from "@hyos/hydb";
import { z } from "zod";

import type {
  WhiteboardBoard,
  WhiteboardBoardCard,
} from "../../../capabilities/whiteboard.js";
import {
  whiteboardBoardCards,
  whiteboardBoardMedia,
  whiteboardBoards,
  whiteboardSchema,
} from "./model.js";

export type { whiteboardSchema };

// Monotonic timestamps keep writes deterministic under rapid edits (the same
// discipline the agent store uses).
let lastWriteTime = 0;
const now = (): Date => {
  lastWriteTime = Math.max(Date.now(), lastWriteTime + 2);
  return new Date(lastWriteTime);
};

// A board save is a whole-list replacement: the board row is created
// lazily, every surviving card is upserted, and cards the renderer
// dropped are deleted. The renderer owns the full card list, so nothing
// is merged.
const saveBoardCommand = hydb.command({
  input: z.object({
    boardId: z.string(),
    now: z.date(),
    cards: z.array(
      z.object({
        id: z.string(),
        x: z.number(),
        y: z.number(),
        markdown: z.string(),
        mediaId: z.string().nullable(),
      }),
    ),
    removedIds: z.array(z.string()),
    removedMediaIds: z.array(z.string()),
  }),
  async handler(transaction, input) {
    if (
      (await transaction.get(whiteboardBoards, [input.boardId])) === undefined
    ) {
      await transaction.insert(whiteboardBoards, {
        id: input.boardId,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } else {
      await transaction.update(whiteboardBoards, [input.boardId], {
        updatedAt: input.now,
      });
    }
    for (const removedId of input.removedIds) {
      if (
        (await transaction.get(whiteboardBoardCards, [removedId])) !== undefined
      ) {
        await transaction.delete(whiteboardBoardCards, [removedId]);
      }
    }
    for (const card of input.cards) {
      const existing = await transaction.get(whiteboardBoardCards, [card.id]);
      if (existing === undefined) {
        await transaction.insert(whiteboardBoardCards, {
          id: card.id,
          boardId: input.boardId,
          x: card.x,
          y: card.y,
          markdown: card.markdown,
          mediaId: card.mediaId,
          createdAt: input.now,
          updatedAt: input.now,
        });
      } else {
        await transaction.update(whiteboardBoardCards, [card.id], {
          x: card.x,
          y: card.y,
          markdown: card.markdown,
          mediaId: card.mediaId,
          updatedAt: input.now,
        });
      }
    }
    // Drop media no surviving card references, so deleted image cards do
    // not leave their bytes behind.
    const referenced = new Set(
      input.cards.flatMap((card) => (card.mediaId ? [card.mediaId] : [])),
    );
    for (const mediaId of input.removedMediaIds) {
      if (!referenced.has(mediaId)) {
        if (
          (await transaction.get(whiteboardBoardMedia, [mediaId])) !== undefined
        ) {
          await transaction.delete(whiteboardBoardMedia, [mediaId]);
        }
      }
    }
  },
});

// Renaming a board writes the title on its row, creating the row if the
// board was never saved — a title must not depend on a prior card save.
const renameBoardCommand = hydb.command({
  input: z.object({
    boardId: z.string(),
    title: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    const existing = await transaction.get(whiteboardBoards, [input.boardId]);
    if (existing === undefined) {
      await transaction.insert(whiteboardBoards, {
        id: input.boardId,
        title: input.title,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } else {
      await transaction.update(whiteboardBoards, [input.boardId], {
        title: input.title,
        updatedAt: input.now,
      });
    }
  },
});

// One image per media row, written as soon as the renderer pastes it —
// before the card that references it is saved.
const saveBoardMediaCommand = hydb.command({
  input: z.object({
    boardId: z.string(),
    mediaId: z.string(),
    data: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    const existing = await transaction.get(whiteboardBoardMedia, [
      input.mediaId,
    ]);
    if (existing === undefined) {
      await transaction.insert(whiteboardBoardMedia, {
        id: input.mediaId,
        boardId: input.boardId,
        data: input.data,
        createdAt: input.now,
      });
    } else {
      await transaction.update(whiteboardBoardMedia, [input.mediaId], {
        data: input.data,
      });
    }
  },
});

export interface WhiteboardStore {
  /** A board's cards and media; a board that was never saved reads as empty. */
  loadBoard(boardId: string): Promise<WhiteboardBoard>;
  /** Replace a board's whole card list with the given one. */
  saveBoard(
    boardId: string,
    cards: readonly WhiteboardBoardCard[],
  ): Promise<void>;
  /** Store one image (a data URL) referenced by a card's mediaId. */
  saveBoardMedia(boardId: string, mediaId: string, data: string): Promise<void>;
  /** Set a board's title; a board row is created if none exists yet. */
  renameBoard(boardId: string, title: string): Promise<void>;
}

export function createWhiteboardStore(database: Database): WhiteboardStore {
  return {
    async loadBoard(boardId) {
      const [row] = await database.fetch(
        hydb
          .query(whiteboardBoards)
          .where((board) => board.id.eq(boardId))
          .many(),
      );
      const rows = await database.fetch(
        hydb
          .query(whiteboardBoardCards)
          .where((card) => card.boardId.eq(boardId))
          .orderBy((card) => [card.id.asc()])
          .many(),
      );
      const mediaRows = await database.fetch(
        hydb
          .query(whiteboardBoardMedia)
          .where((media) => media.boardId.eq(boardId))
          .many(),
      );
      return {
        boardId,
        title: row?.title ?? null,
        cards: rows.map((row) => ({
          id: row.id,
          x: row.x,
          y: row.y,
          markdown: row.markdown,
          mediaId: row.mediaId,
        })),
        media: Object.fromEntries(mediaRows.map((row) => [row.id, row.data])),
      };
    },

    async saveBoard(boardId, cards) {
      const stored = await database.fetch(
        hydb
          .query(whiteboardBoardCards)
          .where((card) => card.boardId.eq(boardId))
          .many(),
      );
      const kept = new Set(cards.map((card) => card.id));
      const removedIds = stored
        .filter((row) => !kept.has(row.id))
        .map((row) => row.id);
      // Media orphans: referenced nowhere after this save, so their image
      // bytes are deleted alongside the cards that pointed at them.
      const referenced = new Set(
        cards.flatMap((card) => (card.mediaId ? [card.mediaId] : [])),
      );
      const storedMedia = await database.fetch(
        hydb
          .query(whiteboardBoardMedia)
          .where((media) => media.boardId.eq(boardId))
          .many(),
      );
      const removedMediaIds = storedMedia
        .filter((row) => !referenced.has(row.id))
        .map((row) => row.id);
      await database.execute(saveBoardCommand, {
        boardId,
        now: now(),
        cards: cards.map((card) => ({ ...card })),
        removedIds,
        removedMediaIds,
      });
    },

    async saveBoardMedia(boardId, mediaId, data) {
      await database.execute(saveBoardMediaCommand, {
        boardId,
        mediaId,
        data,
        now: now(),
      });
    },

    async renameBoard(boardId, title) {
      await database.execute(renameBoardCommand, {
        boardId,
        title,
        now: now(),
      });
    },
  };
}
