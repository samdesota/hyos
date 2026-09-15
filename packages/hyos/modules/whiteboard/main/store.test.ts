import assert from "node:assert/strict";
import test from "node:test";

import { hydb, memoryStorage } from "@hyos/hydb";

import { whiteboardSchema } from "./model.js";
import { createWhiteboardStore } from "./store.js";

test("boards persist whole card lists and replace removed cards", async () => {
  const storage = await memoryStorage({ schema: whiteboardSchema });
  const database = await hydb.database({ schema: whiteboardSchema, storage });
  const store = createWhiteboardStore(database);

  try {
    // A board that was never saved reads as empty.
    const fresh = await store.loadBoard("board-1");
    assert.deepEqual(fresh, {
      boardId: "board-1",
      title: null,
      cards: [],
      media: {},
    });

    await store.saveBoard("board-1", [
      { id: "card-a", x: 10, y: -4.5, markdown: "# a", mediaId: null },
      { id: "card-b", x: 100, y: 200, markdown: "b", mediaId: null },
    ]);
    // A second save moves a card, rewrites its markdown, and drops another.
    await store.saveBoard("board-1", [
      { id: "card-a", x: 12.5, y: 0, markdown: "# a moved", mediaId: null },
      { id: "card-c", x: -1, y: 2, markdown: "c", mediaId: null },
    ]);

    const board = await store.loadBoard("board-1");
    assert.equal(board.boardId, "board-1");
    // Deterministic id order, removed card gone, values round-tripped.
    assert.deepEqual(board.cards, [
      { id: "card-a", x: 12.5, y: 0, markdown: "# a moved", mediaId: null },
      { id: "card-c", x: -1, y: 2, markdown: "c", mediaId: null },
    ]);
  } finally {
    await database.close();
  }
});

test("board titles persist and rename can create an unsaved board", async () => {
  const storage = await memoryStorage({ schema: whiteboardSchema });
  const database = await hydb.database({ schema: whiteboardSchema, storage });
  const store = createWhiteboardStore(database);

  try {
    // A board with no row reads as untitled.
    const fresh = await store.loadBoard("board-1");
    assert.equal(fresh.title, null);

    // Renaming a never-saved board creates its row with the title.
    await store.renameBoard("board-1", "Ideas");
    assert.equal((await store.loadBoard("board-1")).title, "Ideas");

    // Renaming again overwrites, and card saves keep the title.
    await store.renameBoard("board-1", "Ideas v2");
    await store.saveBoard("board-1", [
      { id: "card-a", x: 0, y: 0, markdown: "a", mediaId: null },
    ]);
    const board = await store.loadBoard("board-1");
    assert.equal(board.title, "Ideas v2");
    assert.equal(board.cards.length, 1);
  } finally {
    await database.close();
  }
});

test("board media round-trips and orphaned images are dropped on save", async () => {
  const storage = await memoryStorage({ schema: whiteboardSchema });
  const database = await hydb.database({ schema: whiteboardSchema, storage });
  const store = createWhiteboardStore(database);

  try {
    await store.saveBoardMedia(
      "board-1",
      "media-1",
      "data:image/png;base64,QUJD",
    );
    await store.saveBoard("board-1", [
      { id: "card-a", x: 0, y: 0, markdown: "", mediaId: "media-1" },
    ]);
    const board = await store.loadBoard("board-1");
    assert.deepEqual(board.cards, [
      { id: "card-a", x: 0, y: 0, markdown: "", mediaId: "media-1" },
    ]);
    assert.deepEqual(board.media, {
      "media-1": "data:image/png;base64,QUJD",
    });

    // Dropping the image card removes its media with it.
    await store.saveBoard("board-1", []);
    const emptied = await store.loadBoard("board-1");
    assert.deepEqual(emptied.cards, []);
    assert.deepEqual(emptied.media, {});
  } finally {
    await database.close();
  }
});
