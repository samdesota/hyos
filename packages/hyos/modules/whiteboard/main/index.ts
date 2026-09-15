import path from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import type { MainRemoteCapabilities } from "../../../remote-capabilities.js";
import { defineModule } from "../../../runtime.js";
import { whiteboardCapability } from "../../../capabilities/whiteboard.js";
import { whiteboardSchema } from "./model.js";
import { whiteboardMigrations } from "./migrations/index.js";
import { createWhiteboardStore } from "./store.js";
import { scheduleStorageCollection } from "../../storage-maintenance/maintenance.js";
import type { LogSink } from "../../log-main/sink.js";

type WhiteboardMainConfig = Readonly<{
  storagePath: string;
}>;

export = defineModule<WhiteboardMainConfig>({
  id: "whiteboard.main",
  inject: ["application.root", "log.sink", "remote.capabilities"],
  provide: [],

  async apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const sink = ctx.get<LogSink>("log.sink");
    const storageDirectory = path.resolve(root, config.storagePath);
    const storage = await openNodeStorage({
      directory: storageDirectory,
      schema: whiteboardSchema,
      migrations: whiteboardMigrations,
      // Bound the append-only log; existing storages migrate to this policy
      // and dead history is reclaimed by the periodic collection below.
      retention: {
        mode: "window",
        keepAtLeast: 200,
        keepYoungerThanMs: 86_400_000,
      },
    });
    const database = await hydb.database({ schema: whiteboardSchema, storage });
    const store = createWhiteboardStore(database);

    ctx.effect(() => () => database.close());
    ctx.effect(() =>
      scheduleStorageCollection({
        storage,
        directory: storageDirectory,
        sink,
        source: "whiteboard.main",
      }),
    );
    ctx.effect(() =>
      remote.provide(whiteboardCapability, {
        board: (boardId) => store.loadBoard(boardId),
        saveBoard: (boardId, cards) => store.saveBoard(boardId, cards),
        saveBoardMedia: (boardId, mediaId, data) =>
          store.saveBoardMedia(boardId, mediaId, data),
        renameBoard: (boardId, title) => store.renameBoard(boardId, title),
      }),
    );
  },
});
