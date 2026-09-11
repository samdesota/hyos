import path from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import type { MainRemoteCapabilities } from "../../../remote-capabilities.js";
import { defineModule } from "../../../runtime.js";
import { whiteboardCapability } from "../../../capabilities/whiteboard.js";
import { whiteboardSchema } from "./model.js";
import { createWhiteboardStore } from "./store.js";

type WhiteboardMainConfig = Readonly<{
  storagePath: string;
}>;

export = defineModule<WhiteboardMainConfig>({
  id: "whiteboard.main",
  inject: ["application.root", "remote.capabilities"],
  provide: [],

  async apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const storage = await openNodeStorage({
      directory: path.resolve(root, config.storagePath),
      schema: whiteboardSchema,
    });
    const database = await hydb.database({ schema: whiteboardSchema, storage });
    const store = createWhiteboardStore(database);

    ctx.effect(() => () => database.close());
    ctx.effect(() =>
      remote.provide(whiteboardCapability, {
        board: (boardId) => store.loadBoard(boardId),
        saveBoard: (boardId, cards) => store.saveBoard(boardId, cards),
        saveBoardMedia: (boardId, mediaId, data) =>
          store.saveBoardMedia(boardId, mediaId, data),
      }),
    );
  },
});
