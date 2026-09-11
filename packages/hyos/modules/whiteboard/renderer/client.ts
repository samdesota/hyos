import {
  whiteboardCapability,
  type WhiteboardBoard,
  type WhiteboardBoardCard,
} from "../../../capabilities/whiteboard.js";
import type {
  RemoteConsumer,
  RendererRemoteCapabilities,
} from "../../../remote-capabilities.js";

/**
 * Renderer handle over the `whiteboard` capability: board persistence for
 * one whiteboard page.
 */
export interface WhiteboardClient {
  board(boardId: string): Promise<WhiteboardBoard>;
  saveBoard(
    boardId: string,
    cards: readonly WhiteboardBoardCard[],
  ): Promise<void>;
  saveBoardMedia(boardId: string, mediaId: string, data: string): Promise<void>;
}

export function createWhiteboardClient(
  remote: RendererRemoteCapabilities,
): WhiteboardClient {
  const whiteboard: RemoteConsumer<typeof whiteboardCapability> =
    remote.consume(whiteboardCapability);
  return {
    board: (boardId) => whiteboard.call("board", boardId),
    saveBoard: (boardId, cards) => whiteboard.call("saveBoard", boardId, cards),
    saveBoardMedia: (boardId, mediaId, data) =>
      whiteboard.call("saveBoardMedia", boardId, mediaId, data),
  };
}
